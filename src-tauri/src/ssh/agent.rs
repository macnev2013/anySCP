//! ssh-agent backed public-key authentication.
//!
//! When the user picks a key file, the key may already be unlocked in their
//! ssh-agent (e.g. macOS `AddKeysToAgent` + `UseKeychain`). In that case the
//! agent signs the auth challenge and no passphrase is needed. The key file
//! itself is never decrypted — the `.pub` sidecar identifies which agent
//! identity to use.

use std::path::Path;

use russh::client;
use russh_keys::key::PublicKey;
use tracing::{debug, info, warn};

use super::handler::SshClientHandler;
use super::keys::pub_path_for;

/// Outcome of an ssh-agent authentication attempt.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum AgentAuth {
    /// The server accepted the key, signed by the agent.
    Authenticated,
    /// The agent signed, but the server rejected the key.
    Rejected,
    /// The agent could not sign (locked, key removed, confirmation denied).
    /// The connection is unusable afterwards: russh 0.46 keeps waiting for a
    /// signature and swallows any further auth request, so the caller must
    /// not fall back to another method on the same handle.
    SignFailed(String),
    /// No agent, no `.pub` sidecar, or the key is not loaded — fall back to
    /// decoding the key file.
    Unavailable,
}

/// Read the public half of a private key from its `.pub` sidecar file.
pub(crate) fn sidecar_public_key(key_path: &str) -> Option<PublicKey> {
    let pub_path = pub_path_for(Path::new(key_path));
    match russh_keys::load_public_key(&pub_path) {
        Ok(key) => Some(key),
        Err(e) => {
            debug!(path = %pub_path.display(), error = %e, "no usable .pub sidecar");
            None
        }
    }
}

/// Pick the agent identity matching `wanted`. Returns the agent's own key so
/// its preferred signature hash (rsa-sha2-512 for RSA) is used.
fn find_identity(identities: Vec<PublicKey>, wanted: &PublicKey) -> Option<PublicKey> {
    identities.into_iter().find(|id| id == wanted)
}

/// Agent protocol message numbers (draft-miller-ssh-agent).
#[cfg(unix)]
const SSH_AGENTC_REQUEST_IDENTITIES: u8 = 11;
const SSH_AGENT_IDENTITIES_ANSWER: u8 = 12;
/// Upper bound for an agent reply; real replies are a few KiB.
#[cfg(unix)]
const MAX_AGENT_REPLY: usize = 256 * 1024;

/// Parse an `SSH_AGENT_IDENTITIES_ANSWER` body, skipping keys russh cannot
/// represent (e.g. RSA > 4096 bits). `AgentClient::request_identities` aborts
/// the whole listing on the first such key, hiding every other identity.
#[cfg_attr(not(unix), allow(dead_code))]
fn parse_identities(body: &[u8]) -> Result<Vec<PublicKey>, russh_keys::Error> {
    use russh_keys::encoding::Reader;
    use russh_keys::key::{parse_public_key, SignatureHash};

    if body.first() != Some(&SSH_AGENT_IDENTITIES_ANSWER) {
        return Err(russh_keys::Error::AgentProtocolError);
    }
    let mut r = body.reader(1);
    let count = r.read_u32()?;
    let mut keys = Vec::new();
    for _ in 0..count {
        let blob = r.read_string()?;
        let _comment = r.read_string()?;
        match parse_public_key(blob, Some(SignatureHash::SHA2_512)) {
            Ok(key) => keys.push(key),
            Err(e) => debug!(error = %e, "skipping unsupported agent identity"),
        }
    }
    Ok(keys)
}

/// List the identities held by the agent at `sock`.
#[cfg(unix)]
async fn list_identities(sock: &Path) -> Result<Vec<PublicKey>, russh_keys::Error> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut stream = tokio::net::UnixStream::connect(sock).await?;
    stream
        .write_all(&[0, 0, 0, 1, SSH_AGENTC_REQUEST_IDENTITIES])
        .await?;
    let len = stream.read_u32().await? as usize;
    if len == 0 || len > MAX_AGENT_REPLY {
        return Err(russh_keys::Error::AgentProtocolError);
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    parse_identities(&body)
}

/// Try to authenticate `username` with the agent identity that matches the
/// key at `key_path`. Never fails hard: any agent problem yields
/// [`AgentAuth::Unavailable`] so the caller can fall back to the key file.
#[cfg(unix)]
pub(crate) async fn try_agent_auth(
    handle: &mut client::Handle<SshClientHandler>,
    username: &str,
    key_path: &str,
) -> AgentAuth {
    use russh_keys::agent::client::AgentClient;

    let Some(wanted) = sidecar_public_key(key_path) else {
        return AgentAuth::Unavailable;
    };

    let Some(sock) = std::env::var_os("SSH_AUTH_SOCK") else {
        debug!("SSH_AUTH_SOCK not set");
        return AgentAuth::Unavailable;
    };
    let sock = std::path::PathBuf::from(sock);

    let identities = match list_identities(&sock).await {
        Ok(ids) => ids,
        Err(e) => {
            debug!(error = %e, "ssh-agent identity listing failed");
            return AgentAuth::Unavailable;
        }
    };

    let Some(identity) = find_identity(identities, &wanted) else {
        debug!(key_path, "key is not loaded in ssh-agent");
        return AgentAuth::Unavailable;
    };

    let agent = match AgentClient::connect_uds(&sock).await {
        Ok(agent) => agent,
        Err(e) => {
            warn!(error = %e, "ssh-agent not reachable for signing");
            return AgentAuth::Unavailable;
        }
    };

    let (_agent, result) = handle.authenticate_future(username, identity, agent).await;
    match result {
        Ok(true) => {
            info!(key_path, "authenticated via ssh-agent");
            AgentAuth::Authenticated
        }
        Ok(false) => AgentAuth::Rejected,
        Err(e) => {
            warn!(error = %e, "ssh-agent signing failed");
            AgentAuth::SignFailed(e.to_string())
        }
    }
}

#[cfg(not(unix))]
pub(crate) async fn try_agent_auth(
    _handle: &mut client::Handle<SshClientHandler>,
    _username: &str,
    _key_path: &str,
) -> AgentAuth {
    AgentAuth::Unavailable
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_keys::key::SignatureHash;
    use russh_keys::PublicKeyBase64;

    // Well-known test vector also used in keys.rs tests.
    const ED25519_PUB: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ user@host\n";

    fn write_file(path: &Path, content: &str) {
        std::fs::write(path, content).expect("write file");
    }

    #[test]
    fn sidecar_valid_pub_is_parsed() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key = dir.path().join("id_ed25519");
        write_file(&dir.path().join("id_ed25519.pub"), ED25519_PUB);
        let parsed = sidecar_public_key(key.to_str().unwrap());
        assert!(matches!(parsed, Some(PublicKey::Ed25519(_))));
    }

    #[test]
    fn sidecar_missing_pub_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key = dir.path().join("id_ed25519");
        assert!(sidecar_public_key(key.to_str().unwrap()).is_none());
    }

    #[test]
    fn sidecar_invalid_pub_returns_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key = dir.path().join("id_ed25519");
        write_file(
            &dir.path().join("id_ed25519.pub"),
            "ssh-ed25519 garbage!!! x\n",
        );
        assert!(sidecar_public_key(key.to_str().unwrap()).is_none());
    }

    #[test]
    fn find_identity_matches_same_key() {
        let key =
            russh_keys::parse_public_key_base64(ED25519_PUB.split_whitespace().nth(1).unwrap())
                .unwrap();
        let found = find_identity(vec![key.clone()], &key);
        assert_eq!(found, Some(key));
    }

    #[test]
    fn find_identity_returns_none_without_match() {
        let key =
            russh_keys::parse_public_key_base64(ED25519_PUB.split_whitespace().nth(1).unwrap())
                .unwrap();
        let other = russh_keys::key::KeyPair::generate_ed25519()
            .clone_public_key()
            .unwrap();
        assert_eq!(find_identity(vec![other], &key), None);
    }

    #[test]
    fn find_identity_ignores_rsa_signature_hash() {
        let pair = russh_keys::key::KeyPair::generate_rsa(2048, SignatureHash::SHA2_512).unwrap();
        let agent_key = pair.clone_public_key().unwrap();
        // Same key material, as parsed from a .pub file with a different hash.
        let file_key = russh_keys::key::parse_public_key(
            &agent_key.public_key_bytes(),
            Some(SignatureHash::SHA2_256),
        )
        .unwrap();
        let found = find_identity(vec![agent_key.clone()], &file_key).unwrap();
        // The agent's own key (with its SHA2-512 preference) must be returned.
        assert_eq!(found.name(), "rsa-sha2-512");
    }

    /// Encode an `SSH_AGENT_IDENTITIES_ANSWER` body from raw key blobs.
    fn identities_answer(blobs: &[&[u8]]) -> Vec<u8> {
        let mut body = vec![SSH_AGENT_IDENTITIES_ANSWER];
        body.extend_from_slice(&(blobs.len() as u32).to_be_bytes());
        for blob in blobs {
            body.extend_from_slice(&(blob.len() as u32).to_be_bytes());
            body.extend_from_slice(blob);
            body.extend_from_slice(&[0, 0, 0, 1, b'c']);
        }
        body
    }

    #[test]
    fn parse_identities_skips_unsupported_keys() {
        let good = russh_keys::key::KeyPair::generate_ed25519()
            .clone_public_key()
            .unwrap()
            .public_key_bytes();
        let bad: &[u8] = b"\x00\x00\x00\x07ssh-foo";
        let body = identities_answer(&[bad, &good]);
        let keys = parse_identities(&body).expect("parse");
        assert_eq!(keys.len(), 1);
    }

    #[test]
    fn parse_identities_rejects_wrong_message_type() {
        assert!(parse_identities(&[5, 0, 0, 0, 0]).is_err());
        assert!(parse_identities(&[]).is_err());
    }

    #[test]
    fn parse_identities_rejects_truncated_body() {
        let mut body = identities_answer(&[]);
        body[4] = 3; // claims three identities, carries none
        assert!(parse_identities(&body).is_err());
    }

    fn keygen(args: &[&str], path: &Path) {
        let status = std::process::Command::new("ssh-keygen")
            .args(["-q", "-N", ""])
            .args(args)
            .arg("-f")
            .arg(path)
            .status()
            .expect("ssh-keygen");
        assert!(status.success());
    }

    /// End-to-end against a real `ssh-agent`: a key loaded into the agent is
    /// found through its `.pub` sidecar, even when the agent also holds an
    /// RSA key larger than russh supports (8192 bits).
    #[cfg(unix)]
    #[tokio::test]
    async fn real_agent_lists_matching_identity() {
        use std::process::Command;

        if Command::new("ssh-agent").arg("-h").output().is_err() {
            eprintln!("ssh-agent not installed, skipping");
            return;
        }

        let dir = tempfile::tempdir().expect("tempdir");
        let big_rsa = dir.path().join("id_rsa");
        let key = dir.path().join("id_ed25519");
        let sock = dir.path().join("agent.sock");
        keygen(&["-t", "rsa", "-b", "8192"], &big_rsa);
        keygen(&["-t", "ed25519"], &key);

        let mut agent_proc = Command::new("ssh-agent")
            .arg("-D")
            .arg("-a")
            .arg(&sock)
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("ssh-agent");

        for _ in 0..50 {
            if sock.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        // The oversized RSA key goes in first so it precedes the usable one.
        let added = Command::new("ssh-add")
            .arg(&big_rsa)
            .arg(&key)
            .env("SSH_AUTH_SOCK", &sock)
            .output()
            .expect("ssh-add");

        let result = async {
            assert!(added.status.success(), "ssh-add failed: {added:?}");
            let wanted = sidecar_public_key(key.to_str().unwrap()).expect("sidecar");
            let ids = list_identities(&sock).await.expect("identities");
            find_identity(ids, &wanted)
        }
        .await;

        let _ = agent_proc.kill();
        let _ = agent_proc.wait();
        assert!(result.is_some(), "loaded key not found in agent");
    }

    /// Live check against a real server using the caller's own ssh-agent.
    /// Run with:
    /// `ANYSCP_AGENT_HOST=host ANYSCP_AGENT_USER=user ANYSCP_AGENT_KEY=~/.ssh/id_rsa \
    ///  cargo test --lib live_agent_auth -- --ignored`
    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "needs a live server and a loaded ssh-agent"]
    async fn live_agent_auth() {
        let _ = tracing_subscriber::fmt()
            .with_env_filter("debug")
            .with_test_writer()
            .try_init();
        let host = std::env::var("ANYSCP_AGENT_HOST").expect("ANYSCP_AGENT_HOST");
        let user = std::env::var("ANYSCP_AGENT_USER").expect("ANYSCP_AGENT_USER");
        let key = std::env::var("ANYSCP_AGENT_KEY").expect("ANYSCP_AGENT_KEY");
        let port: u16 = std::env::var("ANYSCP_AGENT_PORT").map_or(22, |p| p.parse().expect("port"));
        let config = std::sync::Arc::new(client::Config::default());
        let mut handle = client::connect(config, (host.as_str(), port), SshClientHandler)
            .await
            .expect("connect");
        assert_eq!(
            try_agent_auth(&mut handle, &user, &key).await,
            AgentAuth::Authenticated
        );
    }
}
