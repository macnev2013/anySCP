//! Encrypted backup / restore of all anySCP data.
//!
//! A backup is a single JSON *envelope* written to a file the user chooses. Its
//! payload — a raw SQLite snapshot of the whole database plus every stored
//! credential — is encrypted with a key derived from the user's passphrase via
//! **Argon2id**, using **AES-256-GCM**. Secrets therefore never touch disk in
//! plaintext, and a backup is useless without the passphrase.
//!
//! - Export: snapshot the DB ([`crate::db::HostDb::export_db_snapshot`]) +
//!   gather credentials from the OS keychain → encrypt → write the envelope.
//! - Import: decrypt with the passphrase → restore the DB snapshot
//!   ([`crate::db::HostDb::import_db_snapshot`]) + write credentials back to the
//!   keychain. A wrong password fails the AEAD tag check and is reported as
//!   such; nothing is modified.

pub mod commands;

use std::collections::BTreeMap;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::db::HostDb;
use crate::vault::{self, StoredCredential};

// ─── Constants ─────────────────────────────────────────────────────────────────

const FORMAT_TAG: &str = "anyscp.backup";
const ENVELOPE_VERSION: u32 = 1;
/// AEAD associated data — binds the ciphertext to this format/version so a blob
/// can't be transplanted into a different context.
const AAD: &[u8] = b"anyscp.backup.v1";
// Argon2id parameters: m = 64 MiB, t = 3, p = 1 — strong, well under a second on
// modern hardware. Stored in the envelope so import derives the same key.
const ARGON2_M_KIB: u32 = 64 * 1024;
const ARGON2_T: u32 = 3;
const ARGON2_P: u32 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

// ─── Error ─────────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("Database error: {0}")]
    Db(String),
    #[error("Incorrect password, or the backup file is corrupt")]
    Decrypt,
    #[error("Crypto error: {0}")]
    Crypto(String),
    #[error("Not a valid anySCP backup file: {0}")]
    Format(String),
    #[error("I/O error: {0}")]
    Io(String),
}

/// Serialize as `{ kind, message }` — same convention as the other error types.
impl Serialize for BackupError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("BackupError", 2)?;
        let kind = match self {
            BackupError::Db(_) => "db",
            BackupError::Decrypt => "decrypt",
            BackupError::Crypto(_) => "crypto",
            BackupError::Format(_) => "format",
            BackupError::Io(_) => "io",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

impl From<crate::db::DbError> for BackupError {
    fn from(e: crate::db::DbError) -> Self {
        BackupError::Db(e.to_string())
    }
}

// ─── On-disk format ──────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct KdfParams {
    algorithm: String,
    m_kib: u32,
    t: u32,
    p: u32,
}

/// The JSON written to the backup file. Only `ciphertext` holds user data; the
/// rest are the public parameters needed to derive the key and decrypt.
#[derive(Debug, Serialize, Deserialize)]
struct Envelope {
    format: String,
    version: u32,
    kdf: KdfParams,
    /// How the plaintext was compressed before encryption: `"gzip"` or `"none"`.
    #[serde(default = "compression_none")]
    compression: String,
    salt: String,
    nonce: String,
    ciphertext: String,
    created_at_unix: u64,
}

fn compression_none() -> String {
    "none".into()
}

// ─── Crypto ─────────────────────────────────────────────────────────────────────

fn derive_key(password: &str, salt: &[u8], p: &KdfParams) -> Result<[u8; KEY_LEN], BackupError> {
    if p.algorithm != "argon2id" {
        return Err(BackupError::Format(format!(
            "unsupported KDF {:?}",
            p.algorithm
        )));
    }
    // The KDF parameters come from the (untrusted) envelope on import. Reject
    // out-of-range values so a malicious file can't request, say, a 16 GiB
    // Argon2 allocation and OOM-kill the app before the tag check. The ceilings
    // sit well above our own export parameters (64 MiB / t=3 / p=1).
    if p.m_kib < 8 || p.m_kib > 1 << 20 || p.t < 1 || p.t > 16 || p.p < 1 || p.p > 16 {
        return Err(BackupError::Format(
            "backup KDF parameters are out of the supported range".into(),
        ));
    }
    let params = Params::new(p.m_kib, p.t, p.p, Some(KEY_LEN))
        .map_err(|e| BackupError::Crypto(e.to_string()))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; KEY_LEN];
    argon2
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| BackupError::Crypto(e.to_string()))?;
    Ok(key)
}

fn encrypt(password: &str, plaintext: &[u8], compression: &str) -> Result<Envelope, BackupError> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut salt).map_err(|e| BackupError::Crypto(e.to_string()))?;
    getrandom::getrandom(&mut nonce).map_err(|e| BackupError::Crypto(e.to_string()))?;

    let kdf = KdfParams {
        algorithm: "argon2id".into(),
        m_kib: ARGON2_M_KIB,
        t: ARGON2_T,
        p: ARGON2_P,
    };
    let key = derive_key(password, &salt, &kdf)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: AAD,
            },
        )
        .map_err(|e| BackupError::Crypto(e.to_string()))?;

    Ok(Envelope {
        format: FORMAT_TAG.into(),
        version: ENVELOPE_VERSION,
        kdf,
        compression: compression.to_string(),
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
        created_at_unix: now_unix(),
    })
}

// ─── Compression + binary framing ──────────────────────────────────────────────
//
// The plaintext is a compact binary frame — `[u32-LE creds_json_len | creds_json
// | raw db bytes]` — then gzip-compressed before encryption. Framing keeps the
// SQLite snapshot as raw bytes (no base64 bloat inside the payload), and gzip
// crushes the snapshot's zero-filled pages, so the backup file is a fraction of
// the raw DB size instead of ~1.8x it.

fn gzip(data: &[u8]) -> Result<Vec<u8>, BackupError> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use std::io::Write;
    let mut enc = GzEncoder::new(Vec::new(), Compression::default());
    enc.write_all(data)
        .map_err(|e| BackupError::Crypto(e.to_string()))?;
    enc.finish().map_err(|e| BackupError::Crypto(e.to_string()))
}

fn gunzip(data: &[u8]) -> Result<Vec<u8>, BackupError> {
    use flate2::read::GzDecoder;
    use std::io::Read;
    let mut out = Vec::new();
    GzDecoder::new(data)
        .read_to_end(&mut out)
        .map_err(|_| BackupError::Format("backup payload is corrupt".into()))?;
    Ok(out)
}

fn encode_frame(creds_json: &[u8], db: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + creds_json.len() + db.len());
    frame.extend_from_slice(&(creds_json.len() as u32).to_le_bytes());
    frame.extend_from_slice(creds_json);
    frame.extend_from_slice(db);
    frame
}

/// Split a frame back into `(creds_json, db_bytes)`.
fn decode_frame(frame: &[u8]) -> Result<(&[u8], &[u8]), BackupError> {
    if frame.len() < 4 {
        return Err(BackupError::Format("truncated backup payload".into()));
    }
    let len = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    let rest = &frame[4..];
    if len > rest.len() {
        return Err(BackupError::Format("corrupt backup payload framing".into()));
    }
    Ok((&rest[..len], &rest[len..]))
}

fn decrypt(password: &str, env: &Envelope) -> Result<Vec<u8>, BackupError> {
    if env.format != FORMAT_TAG {
        return Err(BackupError::Format(format!(
            "unexpected format tag {:?}",
            env.format
        )));
    }
    if env.version > ENVELOPE_VERSION {
        return Err(BackupError::Format(format!(
            "backup format v{} is newer than this app supports (v{ENVELOPE_VERSION})",
            env.version
        )));
    }
    let salt = STANDARD
        .decode(env.salt.as_bytes())
        .map_err(|e| BackupError::Format(e.to_string()))?;
    let nonce = STANDARD
        .decode(env.nonce.as_bytes())
        .map_err(|e| BackupError::Format(e.to_string()))?;
    let ciphertext = STANDARD
        .decode(env.ciphertext.as_bytes())
        .map_err(|e| BackupError::Format(e.to_string()))?;
    if nonce.len() != NONCE_LEN {
        return Err(BackupError::Format("invalid nonce length".into()));
    }

    let key = derive_key(password, &salt, &env.kdf)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: AAD,
            },
        )
        // A wrong password (or any tampering) fails the GCM tag check here.
        .map_err(|_| BackupError::Decrypt)
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ─── Orchestration (sync — callers use spawn_blocking) ──────────────────────────

/// Build the encrypted backup envelope (as a JSON string) for the whole app.
pub fn build_backup(db: &HostDb, password: &str) -> Result<String, BackupError> {
    let db_bytes = db.export_db_snapshot()?;

    // Gather every stored secret keyed by its vault key. Missing entries are
    // simply skipped (a host may have no saved credential).
    let mut credentials: BTreeMap<String, StoredCredential> = BTreeMap::new();
    for h in db.list_hosts()? {
        if let Ok(c) = vault::get_credential(&h.id) {
            credentials.insert(h.id, c);
        }
    }
    for s in db.list_s3_connections()? {
        let key = format!("s3:{}", s.id);
        if let Ok(c) = vault::get_credential(&key) {
            credentials.insert(key, c);
        }
    }

    let creds_json =
        serde_json::to_vec(&credentials).map_err(|e| BackupError::Crypto(e.to_string()))?;
    let frame = encode_frame(&creds_json, &db_bytes);
    let compressed = gzip(&frame)?;
    let envelope = encrypt(password, &compressed, "gzip")?;
    serde_json::to_string_pretty(&envelope).map_err(|e| BackupError::Crypto(e.to_string()))
}

/// Decrypt and restore a backup, replacing all current data and credentials.
pub fn restore_backup(db: &HostDb, password: &str, envelope_json: &str) -> Result<(), BackupError> {
    let envelope: Envelope = serde_json::from_str(envelope_json)
        .map_err(|_| BackupError::Format("not an anySCP backup file".into()))?;
    let plaintext = decrypt(password, &envelope)?;
    let frame = match envelope.compression.as_str() {
        "gzip" => gunzip(&plaintext)?,
        "none" => plaintext,
        other => {
            return Err(BackupError::Format(format!(
                "unsupported backup compression {other:?}"
            )))
        }
    };
    let (creds_json, db_bytes) = decode_frame(&frame)?;
    let credentials: BTreeMap<String, StoredCredential> = serde_json::from_slice(creds_json)
        .map_err(|e| BackupError::Crypto(format!("payload parse failed: {e}")))?;

    // 1. Replace the database (validated + migrated + transactional inside).
    db.import_db_snapshot(db_bytes)?;
    // 2. Restore secrets to the OS keychain. Best-effort per entry so one bad
    //    write doesn't abort the rest; the DB is already restored.
    for (key, cred) in &credentials {
        if let Err(e) = vault::save_credential(key, cred) {
            tracing::warn!(key = %key, error = %e, "restore: failed to write credential to keychain");
        }
    }
    Ok(())
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(password: &str, msg: &[u8]) -> Vec<u8> {
        let env = encrypt(password, msg, "none").expect("encrypt");
        decrypt(password, &env).expect("decrypt")
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let msg = br#"{"hello":"world"}"#;
        assert_eq!(roundtrip("correct horse battery staple", msg), msg);
    }

    #[test]
    fn wrong_password_fails() {
        let env = encrypt("right-password", b"secret data", "none").expect("encrypt");
        let err = decrypt("wrong-password", &env).expect_err("must fail");
        assert!(matches!(err, BackupError::Decrypt), "got {err:?}");
    }

    #[test]
    fn tampered_ciphertext_fails() {
        let mut env = encrypt("pw", b"secret data", "none").expect("encrypt");
        // Flip a byte in the (base64) ciphertext.
        let mut ct = STANDARD.decode(env.ciphertext.as_bytes()).unwrap();
        ct[0] ^= 0xff;
        env.ciphertext = STANDARD.encode(ct);
        assert!(matches!(decrypt("pw", &env), Err(BackupError::Decrypt)));
    }

    #[test]
    fn each_backup_uses_fresh_salt_and_nonce() {
        let a = encrypt("pw", b"data", "none").unwrap();
        let b = encrypt("pw", b"data", "none").unwrap();
        // Same password + plaintext must still yield different salt/nonce/ct.
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn envelope_serializes_with_expected_fields() {
        let env = encrypt("pw", b"x", "none").unwrap();
        let json = serde_json::to_string(&env).unwrap();
        assert!(json.contains("\"format\":\"anyscp.backup\""));
        assert!(json.contains("\"argon2id\""));
        // The plaintext must not leak into the envelope.
        assert!(!json.contains("\"x\""));
    }

    #[test]
    fn rejects_foreign_format_tag() {
        let mut env = encrypt("pw", b"x", "none").unwrap();
        env.format = "something.else".into();
        assert!(matches!(decrypt("pw", &env), Err(BackupError::Format(_))));
    }

    #[test]
    fn frame_roundtrips() {
        let creds = br#"{"host-1":{"type":"Password","password":"x"}}"#;
        let db = &[0u8, 1, 2, 3, 255, 254];
        let frame = encode_frame(creds, db);
        let (c, d) = decode_frame(&frame).expect("decode");
        assert_eq!(c, creds);
        assert_eq!(d, db);
    }

    #[test]
    fn frame_empty_db() {
        let frame = encode_frame(b"{}", &[]);
        let (c, d) = decode_frame(&frame).expect("decode");
        assert_eq!(c, b"{}");
        assert!(d.is_empty());
    }

    #[test]
    fn decode_frame_rejects_truncated() {
        assert!(decode_frame(&[1, 2]).is_err()); // < 4 bytes
                                                 // Length header claims more creds bytes than exist.
        assert!(decode_frame(&[10, 0, 0, 0, b'x']).is_err());
    }

    #[test]
    fn gzip_roundtrips_and_shrinks_zeros() {
        let data = vec![0u8; 64 * 1024]; // mimics SQLite's zero-filled pages
        let z = gzip(&data).expect("gzip");
        assert!(z.len() < data.len() / 10, "zeros should compress hugely");
        assert_eq!(gunzip(&z).expect("gunzip"), data);
    }

    #[test]
    fn gunzip_rejects_garbage() {
        assert!(matches!(
            gunzip(b"not gzip data"),
            Err(BackupError::Format(_))
        ));
    }

    #[test]
    fn build_and_restore_roundtrip_is_compact() {
        use crate::db::HostDb;
        let dir1 = std::env::temp_dir().join(format!("anyscp-bk-src-{}", uuid::Uuid::new_v4()));
        let dir2 = std::env::temp_dir().join(format!("anyscp-bk-dst-{}", uuid::Uuid::new_v4()));
        let src = HostDb::new(&dir1).expect("src db");
        src.save_setting("app_theme", "light")
            .expect("seed setting");

        let backup = build_backup(&src, "hunter2-strong-pw").expect("build_backup");

        // Compression + framing: the encrypted backup is smaller than the raw
        // SQLite snapshot, despite base64 + the GCM tag (the old double-base64
        // format was ~1.8x the snapshot).
        let raw = src.export_db_snapshot().expect("snapshot");
        assert!(
            backup.len() < raw.len(),
            "backup {} should be smaller than raw snapshot {}",
            backup.len(),
            raw.len()
        );

        let dst = HostDb::new(&dir2).expect("dst db");
        // Wrong password must fail (and the GCM tag check means nothing restores).
        assert!(restore_backup(&dst, "wrong-pw", &backup).is_err());
        // Correct password restores the data.
        restore_backup(&dst, "hunter2-strong-pw", &backup).expect("restore_backup");
        assert!(dst
            .load_all_settings()
            .expect("settings")
            .iter()
            .any(|(k, v)| k == "app_theme" && v == "light"));

        let _ = std::fs::remove_dir_all(&dir1);
        let _ = std::fs::remove_dir_all(&dir2);
    }
}
