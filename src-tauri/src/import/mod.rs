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
