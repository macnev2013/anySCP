use std::sync::Arc;

use tauri::State;
use tokio::task;
use tracing::instrument;

use crate::db::{DbError, HostDb, SavedHost};
use crate::types::SshError;

use super::{ImportResult, SshConfigEntry, SshConfigImportEntry};

/// Parse SSH config and return a preview of importable hosts.
#[tauri::command]
#[instrument(skip(db))]
pub async fn import_parse_ssh_config(
    path: Option<String>,
    db: State<'_, Arc<HostDb>>,
) -> Result<Vec<SshConfigEntry>, SshError> {
    let db = Arc::clone(&db);

    task::spawn_blocking(move || {
        // Get existing hosts for duplicate detection
        let existing = db
            .list_hosts()
            .unwrap_or_default()
            .into_iter()
            .map(|h| (h.host, h.username, h.port))
            .collect::<Vec<_>>();

        super::parse_ssh_config(path.as_deref(), &existing)
    })
    .await
    .map_err(|e| SshError::IoError(format!("task panicked: {e}")))?
}

/// Save selected SSH config entries as SavedHosts.
#[tauri::command]
#[instrument(skip(db))]
pub async fn import_save_ssh_hosts(
    entries: Vec<SshConfigImportEntry>,
    db: State<'_, Arc<HostDb>>,
) -> Result<ImportResult, DbError> {
    let host_count = entries.len();
    let db = Arc::clone(&db);

    let result = task::spawn_blocking(move || {
        let mut imported = 0u32;
        let mut skipped = 0u32;
        let mut errors = Vec::new();

        // alias (Host block name) → host id, for ProxyJump resolution.
        let mut alias_to_id: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        // (host id, alias, raw ProxyJump value) tuples that still need resolving.
        let mut pending_jumps: Vec<(String, String, String)> = Vec::new();

        // Whether imported forwards should default to auto-start. OpenSSH
        // auto-activates LocalForward on connect, so the global default is
        // `true` unless the user turned it off in Settings.
        let auto_start_default = auto_start_default(&db);

        // Snapshot of pre-existing hosts so re-importing the same config reuses
        // the existing host (keyed by host+user+port) instead of piling up
        // duplicate host rows — which also makes tunnel import idempotent.
        let preexisting = db.list_hosts().unwrap_or_default();

        for entry in &entries {
            // Reuse an existing host with the same (host, user, port); otherwise
            // create a fresh one. Either way `host_id` is what tunnels bind to.
            let existing = preexisting.iter().find(|h| {
                h.host == entry.hostname && h.username == entry.user && h.port == entry.port
            });

            let host_id = if let Some(h) = existing {
                // Host already present — don't duplicate it, but still attach any
                // newly-added forwards below. Counts as skipped at the host level.
                skipped += 1;
                alias_to_id.insert(entry.host_alias.clone(), h.id.clone());
                h.id.clone()
            } else {
                let now = timestamp_now();
                let id = uuid::Uuid::new_v4().to_string();

                let host = SavedHost {
                    id: id.clone(),
                    label: entry.host_alias.clone(),
                    host: entry.hostname.clone(),
                    port: entry.port as _,
                    username: entry.user.clone(),
                    auth_type: if entry.identity_file.is_some() {
                        "privateKey".to_string()
                    } else {
                        "password".to_string()
                    },
                    key_path: entry.identity_file.clone(),
                    group_id: None,
                    color: None,
                    notes: None,
                    environment: None,
                    os_type: None,
                    startup_command: None,
                    proxy_jump: entry.proxy_jump.clone(),
                    proxy_jump_host_id: None,
                    start_directory: None,
                    keep_alive_interval: entry.keep_alive_interval,
                    default_shell: None,
                    font_size: None,
                    last_connected_at: None,
                    connection_count: None,
                    created_at: now.clone(),
                    updated_at: now,
                };

                match db.save_host(&host) {
                    Ok(()) => {
                        imported += 1;
                        alias_to_id.insert(entry.host_alias.clone(), id.clone());
                        if let Some(pj) = entry.proxy_jump.as_ref().filter(|s| !s.trim().is_empty())
                        {
                            pending_jumps.push((id.clone(), entry.host_alias.clone(), pj.clone()));
                        }
                        id
                    }
                    Err(e) => {
                        errors.push(format!("{}: {e}", entry.host_alias));
                        skipped += 1;
                        continue;
                    }
                }
            };

            // Materialise the host's forward directives as tunnel records,
            // skipping any that already exist (idempotent re-import).
            import_forwards_for_host(
                &db,
                &host_id,
                &entry.host_alias,
                &entry.forwards,
                auto_start_default,
                &mut errors,
            );
        }

        // Second pass: resolve each parsed ProxyJump value against the imported
        // (and pre-existing) hosts, then link via proxy_jump_host_id. Matching is
        // best-effort — an unresolved jump simply leaves the free-text proxy_jump
        // field in place without breaking the import. Linking goes through the
        // *validated* setter so a config with mutually-referencing ProxyJump
        // directives (A→B, B→A) can never persist a connect-breaking cycle.
        let existing_hosts = db.list_hosts().unwrap_or_default();
        for (host_id, alias, jump_value) in pending_jumps {
            // Multi-hop chains (`jump1,jump2`) are retained as free-text but not
            // auto-linked: a single proxy_jump_host_id can't express the chain,
            // and guessing which hop is adjacent to the target risks a wrong link.
            if jump_value.contains(',') {
                continue;
            }
            let Some(jump_id) = resolve_jump_target(&jump_value, &alias_to_id, &existing_hosts)
            else {
                continue;
            };
            match db.set_proxy_jump_host_validated(&host_id, &jump_id) {
                Ok(()) => {}
                // A self-reference / cycle is an expected best-effort skip; only
                // surface genuine write failures so they aren't silently lost.
                Err(DbError::Validation(_)) => {}
                Err(e) => errors.push(format!("{alias}: tunnel link not created: {e}")),
            }
        }

        Ok(ImportResult {
            imported,
            skipped,
            errors,
        })
    })
    .await
    .map_err(|e| DbError::InitError(format!("task panicked: {e}")))?;

    crate::telemetry::capture(
        "ssh_config_imported",
        serde_json::json!({ "host_count": host_count }),
    );
    result
}

fn timestamp_now() -> String {
    // SQLite-compatible datetime string
    "datetime('now')".to_string()
}

/// Read the global "auto-start tunnels by default" preference. Defaults to
/// `true` (matching OpenSSH, which auto-activates forwards on connect) when the
/// setting was never written.
fn auto_start_default(db: &HostDb) -> bool {
    !matches!(
        db.get_setting(crate::portforward::AUTO_START_DEFAULT_SETTING_KEY)
            .ok()
            .flatten()
            .as_deref(),
        Some("false")
    )
}

/// Create one tunnel record per forward directive for `host_id`, skipping any
/// that already exist (matched on the natural key) so re-importing the same
/// config never duplicates tunnels. Failures are recorded per-forward and do
/// not abort the import.
fn import_forwards_for_host(
    db: &HostDb,
    host_id: &str,
    alias: &str,
    forwards: &[super::SshForward],
    auto_start_default: bool,
    errors: &mut Vec<String>,
) {
    for fwd in forwards {
        match db.find_pf_rule_id_by_natural_key(
            host_id,
            &fwd.forward_type,
            &fwd.bind_address,
            fwd.listen_port as u32,
            &fwd.dest_host,
            fwd.dest_port as u32,
        ) {
            Ok(Some(_)) => continue, // already imported — idempotent skip
            Ok(None) => {}
            Err(e) => {
                errors.push(format!("{alias}: tunnel lookup failed: {e}"));
                continue;
            }
        }

        let id = uuid::Uuid::new_v4().to_string();
        let label = format!(
            "{} {}",
            fwd.forward_type
                .get(0..1)
                .map(|c| c.to_uppercase() + &fwd.forward_type[1..])
                .unwrap_or_else(|| fwd.forward_type.clone()),
            fwd.listen_port
        );
        if let Err(e) = db.create_pf_rule(
            &id,
            Some(host_id),
            Some(&label),
            None,
            &fwd.forward_type,
            &fwd.bind_address,
            fwd.listen_port as u32,
            &fwd.dest_host,
            fwd.dest_port as u32,
            auto_start_default,
        ) {
            errors.push(format!("{alias}: tunnel not created: {e}"));
        }
    }
}

/// Resolve a single-hop `ProxyJump` directive value to a saved-host id.
///
/// SSH config ProxyJump values come in several shapes: a bare `Host` alias
/// (`database`), `user@host`, or `user@host:port`. Resolution order:
///
///   1. an exact alias match among the just-imported hosts (this run) — first on
///      the raw value, then on the normalised token (with any `user@`/`:port`
///      stripped). Aliases are unique within a run, so these are unambiguous.
///   2. a *unique* label/hostname match among all saved hosts, comparing both the
///      raw value and the normalised token. If more than one distinct host
///      matches, the value is ambiguous and we return `None` rather than guess.
///
/// Returns `None` when nothing matches (or the match is ambiguous) — the import
/// then leaves the free-text `proxy_jump` field untouched.
fn resolve_jump_target(
    jump_value: &str,
    alias_to_id: &std::collections::HashMap<String, String>,
    existing_hosts: &[SavedHost],
) -> Option<String> {
    let value = jump_value.trim();

    // Normalised token: strip `user@` and `:port` (e.g. `admin@bastion:2222` → `bastion`).
    let without_user = value.rsplit('@').next().unwrap_or(value);
    let host_part = without_user.split(':').next().unwrap_or(without_user);

    // 1. Exact alias match among freshly imported hosts (unique within a run).
    if let Some(id) = alias_to_id.get(value) {
        return Some(id.clone());
    }
    if host_part != value {
        if let Some(id) = alias_to_id.get(host_part) {
            return Some(id.clone());
        }
    }

    // 2. Unique label/hostname match among all saved hosts. Collect distinct host
    //    ids so a collision (e.g. two accounts on one bastion sharing a hostname,
    //    or duplicate labels) is detected and skipped rather than silently
    //    linking the alphabetically-first host.
    let mut matched: Option<&str> = None;
    for h in existing_hosts {
        let is_match =
            h.label == value || h.label == host_part || h.host == host_part || h.host == value;
        if !is_match {
            continue;
        }
        match matched {
            None => matched = Some(&h.id),
            Some(existing) if existing == h.id => {}
            Some(_) => return None, // ambiguous — more than one distinct host matches
        }
    }

    matched.map(|id| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Minimal SavedHost for resolution tests (only id/label/host are consulted).
    fn host(id: &str, label: &str, hostname: &str) -> SavedHost {
        SavedHost {
            id: id.to_string(),
            label: label.to_string(),
            host: hostname.to_string(),
            port: 22,
            username: "u".to_string(),
            auth_type: "password".to_string(),
            group_id: None,
            key_path: None,
            color: None,
            notes: None,
            environment: None,
            os_type: None,
            startup_command: None,
            proxy_jump: None,
            proxy_jump_host_id: None,
            start_directory: None,
            keep_alive_interval: None,
            default_shell: None,
            font_size: None,
            last_connected_at: None,
            connection_count: None,
            created_at: "t".to_string(),
            updated_at: "t".to_string(),
        }
    }

    fn aliases(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(a, id)| (a.to_string(), id.to_string()))
            .collect()
    }

    #[test]
    fn resolves_bare_alias_from_this_run() {
        let a = aliases(&[("bastion", "id-b")]);
        assert_eq!(
            resolve_jump_target("bastion", &a, &[]).as_deref(),
            Some("id-b")
        );
    }

    #[test]
    fn resolves_user_at_host_and_port_via_alias() {
        let a = aliases(&[("bastion", "id-b")]);
        assert_eq!(
            resolve_jump_target("admin@bastion", &a, &[]).as_deref(),
            Some("id-b")
        );
        assert_eq!(
            resolve_jump_target("admin@bastion:2222", &a, &[]).as_deref(),
            Some("id-b")
        );
    }

    #[test]
    fn resolves_label_and_hostname_among_existing() {
        let hosts = vec![host("id-1", "DB Box", "10.0.0.5")];
        // Label match (raw value).
        assert_eq!(
            resolve_jump_target("DB Box", &HashMap::new(), &hosts).as_deref(),
            Some("id-1")
        );
        // Hostname match after stripping user@ and :port.
        assert_eq!(
            resolve_jump_target("ops@10.0.0.5:22", &HashMap::new(), &hosts).as_deref(),
            Some("id-1")
        );
    }

    #[test]
    fn ambiguous_hostname_collision_returns_none() {
        // Two distinct hosts share a hostname — linking either would be a guess.
        let hosts = vec![
            host("id-1", "prod-a", "10.0.0.5"),
            host("id-2", "prod-b", "10.0.0.5"),
        ];
        assert_eq!(
            resolve_jump_target("10.0.0.5", &HashMap::new(), &hosts),
            None
        );
    }

    #[test]
    fn this_run_alias_wins_over_existing_label_collision() {
        let a = aliases(&[("x", "fresh")]);
        let hosts = vec![host("old", "x", "1.2.3.4")];
        assert_eq!(
            resolve_jump_target("x", &a, &hosts).as_deref(),
            Some("fresh")
        );
    }

    #[test]
    fn unmatched_value_returns_none() {
        assert_eq!(resolve_jump_target("nope", &HashMap::new(), &[]), None);
    }

    #[test]
    fn import_forwards_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("anyscp-imp-{}", uuid::Uuid::new_v4()));
        let db = HostDb::new(&dir).expect("db");
        let mut h = host("h1", "web", "10.0.0.1");
        h.created_at = "t".into();
        h.updated_at = "t".into();
        db.save_host(&h).expect("save host");

        let forwards = vec![
            super::super::SshForward {
                forward_type: "local".into(),
                bind_address: "127.0.0.1".into(),
                listen_port: 81,
                dest_host: "localhost".into(),
                dest_port: 81,
            },
            super::super::SshForward {
                forward_type: "dynamic".into(),
                bind_address: "127.0.0.1".into(),
                listen_port: 1080,
                dest_host: String::new(),
                dest_port: 0,
            },
        ];

        let mut errors = Vec::new();
        import_forwards_for_host(&db, "h1", "web", &forwards, true, &mut errors);
        // Re-import the same forwards: must NOT create duplicates.
        import_forwards_for_host(&db, "h1", "web", &forwards, true, &mut errors);

        assert!(errors.is_empty(), "no errors expected: {errors:?}");
        let rules = db.list_pf_rules(Some("h1")).expect("list");
        assert_eq!(rules.len(), 2, "exactly one tunnel per forward, no dupes");
        assert!(rules.iter().all(|r| r.auto_start), "auto_start seeded true");

        std::fs::remove_dir_all(&dir).ok();
    }
}
