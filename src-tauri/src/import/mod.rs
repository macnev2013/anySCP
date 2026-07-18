pub mod commands;

use serde::{Deserialize, Serialize};
use ssh2_config::{ParseRule, SshConfig};
use std::collections::HashMap;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use tracing::info;

use crate::types::SshError;

/// Default bind address used when a forward directive omits one. Mirrors
/// OpenSSH's behaviour (LocalForward/DynamicForward bind the loopback by
/// default) and the project's own port-forwarding default.
const DEFAULT_FORWARD_BIND: &str = "127.0.0.1";

// ─── Types ───────────────────────────────────────────────────────────────────

/// A single SSH port-forwarding directive parsed out of an `ssh_config` host
/// block (`LocalForward` / `RemoteForward` / `DynamicForward`). Mapped onto a
/// tunnel record on import.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SshForward {
    /// Forward kind: `"local"`, `"remote"`, or `"dynamic"` — matches the
    /// strings understood by [`crate::portforward::ForwardType::from_str`].
    pub forward_type: String,
    /// Local/remote bind address the listener is bound to.
    pub bind_address: String,
    /// Listening port.
    pub listen_port: u16,
    /// Destination host (empty for `DynamicForward`, which is a SOCKS proxy).
    pub dest_host: String,
    /// Destination port (0 for `DynamicForward`).
    pub dest_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfigEntry {
    pub host_alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
    pub keep_alive_interval: Option<u32>,
    /// Port-forwarding directives found in this host block (may be empty).
    #[serde(default)]
    pub forwards: Vec<SshForward>,
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
    /// Port-forwarding directives to materialise as tunnel records on import.
    #[serde(default)]
    pub forwards: Vec<SshForward>,
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

    // Pre-scan for port-forwarding directives, grouped by the Host alias they
    // belong to. ssh2-config doesn't surface LocalForward/RemoteForward/
    // DynamicForward, so this is a line-level scan mirroring the alias scan.
    let forwards_by_alias = extract_forwards_by_alias(&config_path)?;

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

        let hostname = params.host_name.as_deref().map(String::from).or_else(|| {
            if !is_pattern {
                Some(alias.clone())
            } else {
                None
            }
        });

        let user = params.user.as_deref().map(String::from);
        let port = params.port;

        // Resolve identity file path
        let identity_file = params
            .identity_file
            .as_ref()
            .and_then(|files| files.first())
            .map(|p| resolve_key_path(p, &home));

        // Preserve the FULL ProxyJump directive (OpenSSH allows a comma-separated
        // multi-hop list `jump1,jump2`). Keeping every hop avoids silently losing
        // the chain; the importer auto-links only the single-hop case (see
        // `resolve_jump_target`), so multi-hop values survive here as provenance.
        let proxy_jump = params
            .proxy_jump
            .as_ref()
            .filter(|jumps| !jumps.is_empty())
            .map(|jumps| jumps.join(","));

        let keep_alive_interval = params.server_alive_interval.map(|d| d.as_secs() as u32);

        // Check for duplicates
        let resolved_host = hostname.as_deref().unwrap_or(alias);
        let resolved_user = user.as_deref().unwrap_or("");
        let resolved_port = port.unwrap_or(22);

        let already_exists = existing_hosts
            .iter()
            .any(|(h, u, p)| h == resolved_host && u == resolved_user && *p == resolved_port);

        let forwards = forwards_by_alias.get(alias).cloned().unwrap_or_default();

        entries.push(SshConfigEntry {
            host_alias: alias.clone(),
            hostname,
            user,
            port,
            identity_file,
            proxy_jump,
            keep_alive_interval,
            forwards,
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
        if let Some(rest) = trimmed
            .strip_prefix("Host ")
            .or_else(|| trimmed.strip_prefix("host "))
        {
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

    if let Some(rest) = path_str.strip_prefix("~/") {
        return format!("{home}/{rest}");
    }

    if path.is_absolute() {
        return path_str.into_owned();
    }

    // Relative path — resolve relative to ~/.ssh/
    format!("{}/.ssh/{}", home, path_str)
}

// ─── Forward directive parsing ─────────────────────────────────────────────────

/// Scan the config file for `LocalForward` / `RemoteForward` / `DynamicForward`
/// directives, grouping each by the `Host` alias(es) of the block it sits in.
///
/// Mirrors the tolerance of the rest of the parser: keywords are matched
/// case-insensitively and accept either `Keyword value` or `Keyword = value`
/// syntax. Pattern aliases (`*`, `?`) and `Match` blocks are ignored — forwards
/// are only attached to concrete host blocks the importer can turn into hosts.
/// Directives that can't be cleanly mapped (e.g. unix-socket paths) are logged
/// and skipped rather than aborting the whole import.
fn extract_forwards_by_alias(path: &Path) -> Result<HashMap<String, Vec<SshForward>>, SshError> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| SshError::IoError(format!("Cannot read {}: {e}", path.display())))?;

    let mut map: HashMap<String, Vec<SshForward>> = HashMap::new();
    // Concrete (non-pattern) aliases of the host block currently being scanned.
    let mut current: Vec<String> = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        // Split "Keyword rest" or "Keyword=rest" into a lowercased keyword and
        // the remaining argument string.
        let mut split = trimmed.splitn(2, |c: char| c.is_whitespace() || c == '=');
        let keyword = split.next().unwrap_or("").to_ascii_lowercase();
        let rest = split.next().unwrap_or("").trim_start_matches('=').trim();

        match keyword.as_str() {
            "host" => {
                current = rest
                    .split_whitespace()
                    .filter(|a| !a.is_empty() && !a.contains('*') && !a.contains('?'))
                    .map(String::from)
                    .collect();
            }
            // A `Match` block changes scope away from a named host; don't attach
            // forwards to whatever host preceded it.
            "match" => current.clear(),
            "localforward" | "remoteforward" | "dynamicforward" => {
                if current.is_empty() {
                    continue;
                }
                match parse_forward_line(&keyword, rest) {
                    Some(fwd) => {
                        for alias in &current {
                            map.entry(alias.clone()).or_default().push(fwd.clone());
                        }
                    }
                    None => {
                        info!(directive = %trimmed, "skipping unparseable forward directive");
                    }
                }
            }
            _ => {}
        }
    }

    Ok(map)
}

/// Parse a single forward directive's argument string into an [`SshForward`].
/// `keyword` is the already-lowercased directive name. Returns `None` for forms
/// that can't be mapped (missing/garbled ports, unix-socket destinations, …).
fn parse_forward_line(keyword: &str, args: &str) -> Option<SshForward> {
    let mut parts = args.split_whitespace();
    let first = parts.next()?;

    match keyword {
        "dynamicforward" => {
            let (bind_address, listen_port) = parse_listen_endpoint(first)?;
            Some(SshForward {
                forward_type: "dynamic".to_string(),
                bind_address,
                listen_port,
                dest_host: String::new(),
                dest_port: 0,
            })
        }
        "localforward" | "remoteforward" => {
            let (bind_address, listen_port) = parse_listen_endpoint(first)?;
            let (dest_host, dest_port) = parse_dest_endpoint(parts.next()?)?;
            let forward_type = if keyword == "remoteforward" {
                "remote"
            } else {
                "local"
            };
            Some(SshForward {
                forward_type: forward_type.to_string(),
                bind_address,
                listen_port,
                dest_host,
                dest_port,
            })
        }
        _ => None,
    }
}

/// Parse the listen endpoint (first argument): `port`, `bind:port`, or
/// `[ipv6]:port`. Falls back to the loopback bind address when none is given.
fn parse_listen_endpoint(token: &str) -> Option<(String, u16)> {
    // `[ipv6]:port`
    if let Some(rest) = token.strip_prefix('[') {
        let (addr, port) = rest.split_once("]:")?;
        return Some((addr.to_string(), port.parse().ok()?));
    }
    // `bind:port`
    if let Some((addr, port)) = token.rsplit_once(':') {
        let port: u16 = port.parse().ok()?;
        let bind = if addr.is_empty() {
            DEFAULT_FORWARD_BIND.to_string()
        } else {
            addr.to_string()
        };
        return Some((bind, port));
    }
    // bare `port`
    Some((DEFAULT_FORWARD_BIND.to_string(), token.parse().ok()?))
}

/// Parse the destination endpoint (`host:hostport` or `[ipv6]:hostport`). Unix
/// socket paths and other non `host:port` forms return `None`.
fn parse_dest_endpoint(token: &str) -> Option<(String, u16)> {
    if let Some(rest) = token.strip_prefix('[') {
        let (host, port) = rest.split_once("]:")?;
        if host.is_empty() {
            return None;
        }
        return Some((host.to_string(), port.parse().ok()?));
    }
    let (host, port) = token.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port.parse().ok()?))
}

#[cfg(test)]
mod forward_tests {
    use super::*;

    fn fwd(t: &str, bind: &str, lp: u16, dh: &str, dp: u16) -> SshForward {
        SshForward {
            forward_type: t.to_string(),
            bind_address: bind.to_string(),
            listen_port: lp,
            dest_host: dh.to_string(),
            dest_port: dp,
        }
    }

    #[test]
    fn parses_local_forward_bare_port() {
        assert_eq!(
            parse_forward_line("localforward", "81 localhost:81"),
            Some(fwd("local", "127.0.0.1", 81, "localhost", 81))
        );
    }

    #[test]
    fn parses_local_forward_with_bind_address() {
        assert_eq!(
            parse_forward_line("localforward", "0.0.0.0:5432 db.internal:5432"),
            Some(fwd("local", "0.0.0.0", 5432, "db.internal", 5432))
        );
    }

    #[test]
    fn parses_remote_forward() {
        assert_eq!(
            parse_forward_line("remoteforward", "8080 localhost:3000"),
            Some(fwd("remote", "127.0.0.1", 8080, "localhost", 3000))
        );
    }

    #[test]
    fn parses_dynamic_forward_no_destination() {
        assert_eq!(
            parse_forward_line("dynamicforward", "1080"),
            Some(fwd("dynamic", "127.0.0.1", 1080, "", 0))
        );
    }

    #[test]
    fn parses_ipv6_listen_endpoint() {
        assert_eq!(
            parse_forward_line("dynamicforward", "[::1]:1080"),
            Some(fwd("dynamic", "::1", 1080, "", 0))
        );
    }

    #[test]
    fn skips_unix_socket_destination() {
        assert_eq!(
            parse_forward_line("localforward", "/tmp/sock localhost:22"),
            None
        );
    }

    #[test]
    fn skips_local_forward_missing_destination() {
        assert_eq!(parse_forward_line("localforward", "81"), None);
    }

    #[test]
    fn groups_multiple_forwards_per_host() {
        let dir = std::env::temp_dir().join(format!("anyscp-fwd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config");
        std::fs::write(
            &path,
            "Host web\n  HostName 10.0.0.1\n  LocalForward 81 localhost:81\n  LocalForward 8888 localhost:8888\n  DynamicForward 1080\n\nHost *\n  LocalForward 9999 localhost:9999\n",
        )
        .unwrap();

        let map = extract_forwards_by_alias(&path).unwrap();
        let web = map.get("web").unwrap();
        assert_eq!(web.len(), 3);
        assert_eq!(web[0], fwd("local", "127.0.0.1", 81, "localhost", 81));
        assert_eq!(web[2], fwd("dynamic", "127.0.0.1", 1080, "", 0));
        // The `Host *` pattern block is ignored entirely.
        assert!(!map.contains_key("*"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
