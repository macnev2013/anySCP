use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::instrument;

use crate::types::SshError;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Metadata about a private key file found in `~/.ssh/`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshKeyInfo {
    /// Filename only (e.g. `"id_ed25519"`).
    pub name: String,
    /// Full absolute path to the private key file.
    pub path: String,
    /// Detected algorithm: one of `"ed25519"`, `"rsa"`, `"ecdsa"`, or `"unknown"`.
    pub algorithm: String,
    /// SHA-256 fingerprint from the corresponding `.pub` file, formatted as
    /// `"SHA256:<base64>"`.  Falls back to `"unknown"` when the `.pub` file is
    /// missing or cannot be parsed.
    pub fingerprint: String,
    /// Always `false` for now — passphrase detection requires decryption.
    pub has_passphrase: bool,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Scan `~/.ssh/` for private key files and return metadata for each one.
///
/// A file is treated as a private key when it:
/// - Does **not** end in `.pub`
/// - Matches a common private-key naming convention: starts with `id_`,
///   ends with `.pem`, or whose first line contains `"-----BEGIN"`
#[instrument]
pub fn list_ssh_keys() -> Result<Vec<SshKeyInfo>, SshError> {
    let ssh_dir = ssh_dir()?;

    if !ssh_dir.exists() {
        return Ok(Vec::new());
    }

    let entries = std::fs::read_dir(&ssh_dir).map_err(|e| {
        SshError::IoError(format!(
            "cannot read ~/.ssh directory {}: {e}",
            ssh_dir.display()
        ))
    })?;

    let mut keys = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|e| SshError::IoError(format!("directory entry error: {e}")))?;
        let path = entry.path();

        // Skip anything that is not a regular file.
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }

        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };

        // Skip public keys — we only want private key files.
        if file_name.ends_with(".pub") {
            continue;
        }

        // Accept files matching common private-key patterns.
        if !is_likely_private_key(&file_name, &path) {
            continue;
        }

        let algorithm = detect_algorithm(&path, &file_name);
        let fingerprint = get_key_fingerprint(&path);

        keys.push(SshKeyInfo {
            name: file_name,
            path: path.to_string_lossy().into_owned(),
            algorithm,
            fingerprint,
            has_passphrase: false,
        });
    }

    // Stable ordering: sort by name so the list is deterministic.
    keys.sort_by(|a, b| a.name.cmp(&b.name));

    Ok(keys)
}

/// Inspect a single private key file at any path and return its metadata.
/// Also validates that russh can parse it (returns an error if not).
#[instrument(fields(path = %path))]
pub fn inspect_ssh_key(path: &str) -> Result<SshKeyInfo, SshError> {
    let p = Path::new(path);

    if !p.exists() {
        return Err(SshError::IoError(format!("File not found: {path}")));
    }

    let file_name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("key")
        .to_string();

    // Try to parse the key to validate it
    let key_data = std::fs::read_to_string(p)
        .map_err(|e| SshError::IoError(format!("Cannot read {path}: {e}")))?;

    // Try without passphrase first to validate format
    let parse_result = russh_keys::decode_secret_key(&key_data, None);
    let needs_passphrase = if parse_result.is_err() {
        // Could be passphrase-protected — that's ok, it's still a valid key format
        // Check if it at least looks like a key file
        if !key_data.contains("-----BEGIN") && !key_data.contains("PRIVATE KEY") && !key_data.contains("PuTTY") {
            return Err(SshError::KeyParseError(format!(
                "File does not appear to be a valid SSH private key: {file_name}"
            )));
        }
        true
    } else {
        false
    };

    let algorithm = detect_algorithm(p, &file_name);
    let fingerprint = get_key_fingerprint(p);

    Ok(SshKeyInfo {
        name: file_name,
        path: p.to_string_lossy().into_owned(),
        algorithm,
        fingerprint,
        has_passphrase: needs_passphrase,
    })
}

/// Check if key data looks like a PuTTY PPK format.
pub fn is_ppk_format(key_data: &str) -> bool {
    key_data.starts_with("PuTTY-User-Key-File-2:") || key_data.starts_with("PuTTY-User-Key-File-3:")
}

/// Convert a PPK file to OpenSSH format using puttygen.
/// Returns the converted key data as a string.
/// If puttygen is not available, returns an error with install instructions.
pub fn convert_ppk_to_openssh(ppk_path: &str, passphrase: Option<&str>) -> Result<String, SshError> {
    // Check if puttygen is available
    let which = std::process::Command::new("which")
        .arg("puttygen")
        .output();

    if which.is_err() || !which.unwrap().status.success() {
        return Err(SshError::KeyParseError(
            "PuTTY PPK key detected but 'puttygen' is not installed. \
             Install it with: brew install putty (macOS) or apt install putty-tools (Linux). \
             Alternatively, convert your key manually: puttygen key.ppk -O private-openssh -o key"
                .to_string(),
        ));
    }

    // Create a temp file for the output
    let temp_dir = std::env::temp_dir();
    let temp_out = temp_dir.join(format!("anyscp_converted_{}", uuid::Uuid::new_v4()));

    let mut cmd = std::process::Command::new("puttygen");
    cmd.arg(ppk_path)
        .arg("-O")
        .arg("private-openssh")
        .arg("-o")
        .arg(&temp_out);

    // For passphrase-protected keys, write passphrase to a temp file
    // and pass via --old-passphrase <file>
    let passphrase_file = if let Some(pass) = passphrase {
        let pf = temp_dir.join(format!("anyscp_pass_{}", uuid::Uuid::new_v4()));
        std::fs::write(&pf, pass).map_err(|e| {
            SshError::IoError(format!("Cannot write passphrase file: {e}"))
        })?;
        cmd.arg("--old-passphrase").arg(&pf);
        // Output key without passphrase (so russh can read it)
        cmd.arg("--new-passphrase").arg("/dev/null");
        Some(pf)
    } else {
        None
    };

    let output = cmd.output().map_err(|e| {
        if let Some(pf) = &passphrase_file { let _ = std::fs::remove_file(pf); }
        SshError::KeyParseError(format!("Failed to run puttygen: {e}"))
    })?;

    // Clean up passphrase file immediately
    if let Some(pf) = &passphrase_file { let _ = std::fs::remove_file(pf); }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // Clean up temp file
        let _ = std::fs::remove_file(&temp_out);
        return Err(SshError::KeyParseError(format!(
            "puttygen conversion failed: {stderr}"
        )));
    }

    // Read the converted key
    let converted = std::fs::read_to_string(&temp_out).map_err(|e| {
        let _ = std::fs::remove_file(&temp_out);
        SshError::IoError(format!("Cannot read converted key: {e}"))
    })?;

    // Clean up
    let _ = std::fs::remove_file(&temp_out);

    if converted.is_empty() {
        return Err(SshError::KeyParseError("Conversion produced empty output".to_string()));
    }

    Ok(converted)
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Returns the path to the user's `~/.ssh/` directory.
fn ssh_dir() -> Result<PathBuf, SshError> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| SshError::IoError("cannot determine home directory (HOME/USERPROFILE unset)".to_string()))?;
    Ok(PathBuf::from(home).join(".ssh"))
}

/// Return `true` when the file looks like a private SSH key.
///
/// Heuristics (any one is sufficient):
/// 1. Name starts with `id_`  (e.g. `id_rsa`, `id_ed25519`, `id_ecdsa`)
/// 2. Name ends with `.pem`
/// 3. First bytes of the file start with `-----BEGIN`
fn is_likely_private_key(file_name: &str, path: &Path) -> bool {
    if file_name.starts_with("id_") || file_name.ends_with(".pem") {
        return true;
    }
    // Peek at the first 10 bytes to check for a PEM header.
    if let Ok(mut f) = std::fs::File::open(path) {
        use std::io::Read;
        let mut buf = [0u8; 10];
        if f.read_exact(&mut buf).is_ok() && buf.starts_with(b"-----BEGIN") {
            return true;
        }
    }
    false
}

/// Detect the algorithm by reading the first line of the private key file.
/// For OpenSSH keys we also consult the `.pub` sidecar file.
fn detect_algorithm(path: &Path, file_name: &str) -> String {
    let first_line = read_first_line(path);

    if first_line.contains("OPENSSH PRIVATE KEY") {
        // OpenSSH format — the algorithm name is embedded in the binary blob;
        // reading the `.pub` file is far simpler and reliable enough.
        return algorithm_from_pub_file(path, file_name);
    }
    if first_line.contains("RSA") {
        return "rsa".to_string();
    }
    if first_line.contains("EC") {
        return "ecdsa".to_string();
    }
    "unknown".to_string()
}

/// Read only the first non-empty line of a file, returning an empty string on
/// any I/O error.
fn read_first_line(path: &Path) -> String {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(path) else {
        return String::new();
    };
    let reader = std::io::BufReader::new(file);
    for line in reader.lines().flatten() {
        let trimmed = line.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    String::new()
}

/// Infer the algorithm from the algorithm token in a `.pub` file's second
/// space-delimited field (e.g. `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`).
fn algorithm_from_pub_file(path: &Path, _file_name: &str) -> String {
    let pub_path = pub_path_for(path);
    let Ok(content) = std::fs::read_to_string(&pub_path) else {
        return "unknown".to_string();
    };
    // Format: `<algo> <base64-key> [comment]`
    let algo_token = content.split_whitespace().next().unwrap_or("").to_lowercase();
    if algo_token.contains("ed25519") {
        "ed25519".to_string()
    } else if algo_token.contains("rsa") {
        "rsa".to_string()
    } else if algo_token.contains("ecdsa") {
        "ecdsa".to_string()
    } else {
        "unknown".to_string()
    }
}

/// Construct the `.pub` sidecar path for a private key (same name + `".pub"`).
fn pub_path_for(private_key_path: &Path) -> PathBuf {
    let mut p = private_key_path.to_path_buf();
    let ext = match p.extension() {
        Some(e) => format!("{}.pub", e.to_string_lossy()),
        None => "pub".to_string(),
    };
    p.set_extension(ext);
    p
}

/// Read the `.pub` file for a given private key path, parse the base64 key
/// blob with `russh_keys`, and return the SHA-256 fingerprint formatted as
/// `"SHA256:<base64>"`.
///
/// Returns `"unknown"` if:
/// - No `.pub` file exists next to the private key
/// - The file cannot be read or does not have the expected format
/// - `russh_keys` fails to parse the key blob
fn get_key_fingerprint(private_key_path: &Path) -> String {
    let pub_path = pub_path_for(private_key_path);
    let Ok(content) = std::fs::read_to_string(&pub_path) else {
        return "unknown".to_string();
    };

    // A `.pub` file line looks like:
    //   ssh-ed25519 AAAA...base64... optional comment
    // The base64 key data is the second whitespace-separated token.
    let mut tokens = content.split_whitespace();
    let _algo = tokens.next();
    let Some(b64) = tokens.next() else {
        return "unknown".to_string();
    };

    match russh_keys::parse_public_key_base64(b64) {
        Ok(pub_key) => format!("SHA256:{}", pub_key.fingerprint()),
        Err(_) => "unknown".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_file(path: &Path, content: &str) {
        let mut f = std::fs::File::create(path).expect("create file");
        f.write_all(content.as_bytes()).expect("write file");
    }

    #[test]
    fn pub_path_for_no_extension() {
        let p = Path::new("/home/user/.ssh/id_ed25519");
        assert_eq!(pub_path_for(p), Path::new("/home/user/.ssh/id_ed25519.pub"));
    }

    #[test]
    fn pub_path_for_pem_extension() {
        let p = Path::new("/home/user/.ssh/mykey.pem");
        assert_eq!(pub_path_for(p), Path::new("/home/user/.ssh/mykey.pem.pub"));
    }

    #[test]
    fn detect_rsa_from_header() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key_path = dir.path().join("id_rsa");
        write_file(
            &key_path,
            "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n",
        );
        assert_eq!(detect_algorithm(&key_path, "id_rsa"), "rsa");
    }

    #[test]
    fn detect_ec_from_header() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key_path = dir.path().join("id_ecdsa");
        write_file(
            &key_path,
            "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEE...\n-----END EC PRIVATE KEY-----\n",
        );
        assert_eq!(detect_algorithm(&key_path, "id_ecdsa"), "ecdsa");
    }

    #[test]
    fn detect_ed25519_from_pub_sidecar() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key_path = dir.path().join("id_ed25519");
        write_file(
            &key_path,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
        );
        let pub_path = dir.path().join("id_ed25519.pub");
        write_file(
            &pub_path,
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ user@host\n",
        );
        assert_eq!(detect_algorithm(&key_path, "id_ed25519"), "ed25519");
    }

    #[test]
    fn is_likely_private_key_id_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("id_rsa");
        write_file(&p, "anything");
        assert!(is_likely_private_key("id_rsa", &p));
    }

    #[test]
    fn is_likely_private_key_pem_extension() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("key.pem");
        write_file(&p, "anything");
        assert!(is_likely_private_key("key.pem", &p));
    }

    #[test]
    fn is_likely_private_key_begin_header() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("custom_key");
        write_file(&p, "-----BEGIN OPENSSH PRIVATE KEY-----\n...");
        assert!(is_likely_private_key("custom_key", &p));
    }

    #[test]
    fn is_not_likely_private_key_random_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path().join("config");
        write_file(&p, "Host *\n  ServerAliveInterval 60\n");
        assert!(!is_likely_private_key("config", &p));
    }

    #[test]
    fn fingerprint_missing_pub_returns_unknown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key_path = dir.path().join("id_ed25519");
        write_file(&key_path, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
        // No .pub file created — fingerprint must fall back gracefully.
        assert_eq!(get_key_fingerprint(&key_path), "unknown");
    }

    #[test]
    fn fingerprint_invalid_pub_returns_unknown() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key_path = dir.path().join("id_ed25519");
        write_file(&key_path, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
        let pub_path = dir.path().join("id_ed25519.pub");
        write_file(&pub_path, "ssh-ed25519 not_valid_base64!!! user@host\n");
        assert_eq!(get_key_fingerprint(&key_path), "unknown");
    }

    #[test]
    fn fingerprint_valid_pub_returns_sha256_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let key_path = dir.path().join("id_ed25519");
        write_file(&key_path, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
        let pub_path = dir.path().join("id_ed25519.pub");
        // This is a well-known test vector used in russh-keys own tests.
        write_file(
            &pub_path,
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ user@host\n",
        );
        let fp = get_key_fingerprint(&key_path);
        assert!(
            fp.starts_with("SHA256:"),
            "expected SHA256: prefix, got: {fp}"
        );
    }

    #[test]
    fn list_ssh_keys_skips_pub_files_and_non_keys() {
        let dir = tempfile::tempdir().expect("tempdir");

        // Private key
        let id_ed = dir.path().join("id_ed25519");
        write_file(
            &id_ed,
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
        );
        // Public key sidecar — must be skipped
        let id_ed_pub = dir.path().join("id_ed25519.pub");
        write_file(
            &id_ed_pub,
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ user@host\n",
        );
        // Non-key config file — must be skipped
        write_file(&dir.path().join("config"), "Host *\n  ServerAliveInterval 60\n");
        // known_hosts — must be skipped
        write_file(&dir.path().join("known_hosts"), "github.com ssh-rsa AAA...\n");

        // Override HOME so list_ssh_keys points at our temp dir.
        // We call the internals directly to avoid mutating process env.
        let entries: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| {
                let p = e.path();
                if !p.is_file() { return false; }
                let name = p.file_name().unwrap().to_string_lossy().into_owned();
                !name.ends_with(".pub") && is_likely_private_key(&name, &p)
            })
            .collect();

        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].file_name().to_string_lossy().as_ref(),
            "id_ed25519"
        );
    }
}
