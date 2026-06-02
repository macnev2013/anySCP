pub mod commands;

use serde::{Deserialize, Serialize};
use ssh2_config::{ParseRule, SshConfig};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use tracing::info;

use crate::types::SshError;

// ─── Types ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfigEntry {
    pub host_alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub keep_alive_interval: Option<u32>,
    pub is_pattern: bool,
    pub already_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfigImportEntry {
    pub host_alias: String,
    pub hostname: String,
    pub user: String,
    pub port: u16,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub keep_alive_interval: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub errors: Vec<String>,
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/// Parse an SSH config file and return a list of importable host entries.
pub fn parse_ssh_config(
    path: Option<&str>,
    existing_hosts: &[(String, String, u16)], // (host, username, port) tuples
) -> Result<Vec<SshConfigEntry>, SshError> {
    let config_path = match path {
        Some(p) => PathBuf::from(p),
        None => default_ssh_config_path()?,
    };

    if !config_path.exists() {
        return Err(SshError::IoError(format!(
            "SSH config not found: {}",
            config_path.display()
        )));
    }

    // Read and parse with ssh2-config
    let file = std::fs::File::open(&config_path)
        .map_err(|e| SshError::IoError(format!("Cannot read {}: {e}", config_path.display())))?;
    let mut reader = BufReader::new(file);

    let config = SshConfig::default()
        .parse(&mut reader, ParseRule::ALLOW_UNKNOWN_FIELDS)
        .map_err(|e| SshError::IoError(format!("Failed to parse SSH config: {e}")))?;

    // Pre-scan for Host block names
    let host_aliases = extract_host_aliases(&config_path)?;

    info!(
        path = %config_path.display(),
        hosts = host_aliases.len(),
        "Parsed SSH config"
    );

    let home = home_dir();
    let mut entries = Vec::new();

    for alias in &host_aliases {
        let is_pattern = alias.contains('*') || alias.contains('?');

        // Query resolved params
        let params = config.query(alias);

        let hostname = params
            .host_name
            .as_deref()
            .map(String::from)
            .or_else(|| if !is_pattern { Some(alias.clone()) } else { None });

        let user = params.user.as_deref().map(String::from);
        let port = params.port;

        // Resolve identity file path
        let identity_file = params
            .identity_file
            .as_ref()
            .and_then(|files| files.first())
            .map(|p| resolve_key_path(p, &home));

        let proxy_jump = params
            .proxy_jump
            .as_ref()
            .and_then(|jumps| jumps.first())
            .map(|j| format!("{}", j));

        let keep_alive_interval = params
            .server_alive_interval
            .map(|d| d.as_secs() as u32);

        // Check for duplicates
        let resolved_host = hostname.as_deref().unwrap_or(alias);
        let resolved_user = user.as_deref().unwrap_or("");
        let resolved_port = port.unwrap_or(22);

        let already_exists = existing_hosts.iter().any(|(h, u, p)| {
            h == resolved_host && u == resolved_user && *p == resolved_port
        });

        entries.push(SshConfigEntry {
            host_alias: alias.clone(),
            hostname,
            user,
            port,
            identity_file,
            proxy_jump,
            keep_alive_interval,
            is_pattern,
            already_exists,
        });
    }

    Ok(entries)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn default_ssh_config_path() -> Result<PathBuf, SshError> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| SshError::IoError("Cannot determine home directory".to_string()))?;
    Ok(PathBuf::from(home).join(".ssh").join("config"))
}

fn home_dir() -> String {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default()
}

/// Extract Host alias names from config file by line scanning.
/// ssh2-config doesn't expose a list_hosts() API.
fn extract_host_aliases(path: &Path) -> Result<Vec<String>, SshError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| SshError::IoError(format!("Cannot read {}: {e}", path.display())))?;

    let mut aliases = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();

        // Skip comments and empty lines
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // Match "Host ..." lines (case-insensitive)
        if let Some(rest) = trimmed.strip_prefix("Host ").or_else(|| trimmed.strip_prefix("host ")) {
            // A Host line can have multiple space-separated patterns
            for alias in rest.split_whitespace() {
                let alias = alias.trim();
                if !alias.is_empty() && alias != "*" {
                    aliases.push(alias.to_string());
                }
            }
        }
    }

    // Deduplicate
    aliases.sort();
    aliases.dedup();

    Ok(aliases)
}

/// Resolve a key path: expand ~ and make relative paths absolute to ~/.ssh/
fn resolve_key_path(path: &Path, home: &str) -> String {
    let path_str = path.to_string_lossy();

    if path_str.starts_with("~/") {
        return format!("{}/{}", home, &path_str[2..]);
    }

    if path.is_absolute() {
        return path_str.into_owned();
    }

    // Relative path — resolve relative to ~/.ssh/
    format!("{}/.ssh/{}", home, path_str)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_config(dir: &Path, contents: &str) -> PathBuf {
        let path = dir.join("config");
        let mut f = std::fs::File::create(&path).expect("create config");
        f.write_all(contents.as_bytes()).expect("write config");
        path
    }

    // ---- resolve_key_path ---------------------------------------------------

    #[test]
    fn resolve_key_path_expands_tilde() {
        let resolved = resolve_key_path(Path::new("~/keys/id_ed25519"), "/home/u");
        assert_eq!(resolved, "/home/u/keys/id_ed25519");
    }

    #[test]
    fn resolve_key_path_keeps_absolute_paths_unchanged() {
        let resolved = resolve_key_path(Path::new("/etc/ssh/id_rsa"), "/home/u");
        assert_eq!(resolved, "/etc/ssh/id_rsa");
    }

    #[test]
    fn resolve_key_path_treats_bare_filename_as_relative_to_ssh_dir() {
        let resolved = resolve_key_path(Path::new("custom_key"), "/home/u");
        assert_eq!(resolved, "/home/u/.ssh/custom_key");
    }

    // ---- extract_host_aliases -----------------------------------------------

    #[test]
    fn extract_host_aliases_finds_simple_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            "Host alpha\n  HostName 10.0.0.1\n\nHost beta\n  HostName 10.0.0.2\n",
        );
        let aliases = extract_host_aliases(&path).unwrap();
        assert_eq!(aliases, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[test]
    fn extract_host_aliases_handles_comments_and_blank_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            "# top comment\n\n  # indented comment\nHost gamma\n  HostName 1.2.3.4\n",
        );
        let aliases = extract_host_aliases(&path).unwrap();
        assert_eq!(aliases, vec!["gamma".to_string()]);
    }

    #[test]
    fn extract_host_aliases_splits_multi_alias_lines() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            "Host web1 web2 web3\n  User deploy\n",
        );
        let aliases = extract_host_aliases(&path).unwrap();
        assert_eq!(
            aliases,
            vec!["web1".to_string(), "web2".to_string(), "web3".to_string()]
        );
    }

    #[test]
    fn extract_host_aliases_excludes_bare_wildcard_but_keeps_patterns() {
        // `Host *` is the catch-all default block — never importable on its own.
        // `Host *.prod` is a pattern that should still surface so the importer
        // can flag it as `is_pattern`.
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            "Host *\n  ServerAliveInterval 60\n\nHost *.prod\n  User deploy\n",
        );
        let aliases = extract_host_aliases(&path).unwrap();
        assert_eq!(aliases, vec!["*.prod".to_string()]);
    }

    #[test]
    fn extract_host_aliases_deduplicates_repeated_blocks() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            "Host alpha\n  HostName 1\nHost alpha\n  User root\nHost beta\n",
        );
        let aliases = extract_host_aliases(&path).unwrap();
        assert_eq!(aliases, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[test]
    fn extract_host_aliases_is_case_insensitive_for_directive() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "host lowercase\nHost Mixed\n");
        let aliases = extract_host_aliases(&path).unwrap();
        // Sorted output: capital letters precede lowercase in ASCII.
        assert_eq!(aliases, vec!["Mixed".to_string(), "lowercase".to_string()]);
    }

    // ---- parse_ssh_config ---------------------------------------------------

    #[test]
    fn parse_ssh_config_missing_file_returns_io_error() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does_not_exist");
        let err =
            parse_ssh_config(Some(missing.to_str().unwrap()), &[]).unwrap_err();
        match err {
            SshError::IoError(msg) => {
                assert!(msg.contains("SSH config not found"), "got: {msg}");
            }
            other => panic!("expected IoError, got {other:?}"),
        }
    }

    #[test]
    fn parse_ssh_config_resolves_hostname_user_and_port() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            "Host myhost\n  HostName example.com\n  User deploy\n  Port 2222\n",
        );

        let entries =
            parse_ssh_config(Some(path.to_str().unwrap()), &[]).unwrap();
        assert_eq!(entries.len(), 1);
        let e = &entries[0];
        assert_eq!(e.host_alias, "myhost");
        assert_eq!(e.hostname.as_deref(), Some("example.com"));
        assert_eq!(e.user.as_deref(), Some("deploy"));
        assert_eq!(e.port, Some(2222));
        assert!(!e.is_pattern);
        assert!(!e.already_exists);
    }

    #[test]
    fn parse_ssh_config_falls_back_hostname_to_alias_for_non_patterns() {
        // When a Host block has no explicit HostName, ssh uses the alias.
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(dir.path(), "Host plain\n  User root\n");

        let entries =
            parse_ssh_config(Some(path.to_str().unwrap()), &[]).unwrap();
        let e = &entries[0];
        assert_eq!(e.hostname.as_deref(), Some("plain"));
        assert_eq!(e.user.as_deref(), Some("root"));
    }

    #[test]
    fn parse_ssh_config_marks_patterns_and_leaves_hostname_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            "Host *.example.com\n  User deploy\n",
        );

        let entries =
            parse_ssh_config(Some(path.to_str().unwrap()), &[]).unwrap();
        let e = &entries[0];
        assert_eq!(e.host_alias, "*.example.com");
        assert!(e.is_pattern);
        // Patterns can't be expanded into a concrete hostname.
        assert!(e.hostname.is_none(), "got hostname: {:?}", e.hostname);
    }

    #[test]
    fn parse_ssh_config_flags_existing_hosts_as_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            "Host dup\n  HostName 10.0.0.5\n  User admin\n  Port 22\n\
             Host fresh\n  HostName 10.0.0.6\n  User admin\n  Port 22\n",
        );

        let existing = vec![("10.0.0.5".to_string(), "admin".to_string(), 22u16)];
        let entries =
            parse_ssh_config(Some(path.to_str().unwrap()), &existing).unwrap();

        let dup = entries.iter().find(|e| e.host_alias == "dup").unwrap();
        let fresh = entries.iter().find(|e| e.host_alias == "fresh").unwrap();
        assert!(dup.already_exists);
        assert!(!fresh.already_exists);
    }

    #[test]
    fn parse_ssh_config_resolves_identity_file_with_tilde() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_config(
            dir.path(),
            "Host kh\n  HostName a.b.c\n  IdentityFile ~/.ssh/special_key\n",
        );

        let entries =
            parse_ssh_config(Some(path.to_str().unwrap()), &[]).unwrap();
        let id = entries[0]
            .identity_file
            .as_deref()
            .expect("identity_file should be set");
        // Whatever HOME is in the test environment, the leading "~/" must
        // have been expanded.
        assert!(!id.starts_with("~/"), "tilde not expanded: {id}");
        assert!(id.ends_with("/.ssh/special_key"), "got: {id}");
    }
}
