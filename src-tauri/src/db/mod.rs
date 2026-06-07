pub mod commands;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tracing::instrument;

use crate::snippets::{Snippet, SnippetFolder, SnippetSearchResult};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("Database error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Host not found: {0}")]
    NotFound(String),

    #[error("Failed to initialize database: {0}")]
    InitError(String),

    #[error("{0}")]
    Validation(String),
}

/// Serialize DbError as `{ kind, message }` so the frontend can pattern-match
/// on the `kind` discriminant — mirrors the SshError pattern.
impl Serialize for DbError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("DbError", 2)?;
        let kind = match self {
            DbError::Sqlite(_) => "sqlite",
            DbError::NotFound(_) => "not_found",
            DbError::InitError(_) => "init_error",
            DbError::Validation(_) => "validation",
        };
        state.serialize_field("kind", kind)?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

/// A recent connection entry joining `connection_history` with `saved_hosts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentConnection {
    pub host_id: String,
    pub host_label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub connected_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionHistoryEntry {
    pub id: i64,
    pub host_id: String,
    pub host_label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub connected_at: String,
}

/// A persisted host entry.  Secrets (passwords, private keys) are intentionally
/// absent — those live in the credential vault (Phase 2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedHost {
    pub id: String,
    pub label: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// One of: "password", "privateKey", "privateKeyData"
    pub auth_type: String,
    pub group_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,

    // Auth persistence
    /// Remembered SSH key path used for this host.
    pub key_path: Option<String>,

    // Appearance
    /// Custom hex colour string for the host avatar (e.g. `#6366f1`).
    pub color: Option<String>,

    // Metadata
    /// Free-text notes about the host.
    pub notes: Option<String>,
    /// Deployment environment label: "production", "staging", "dev", "testing".
    pub environment: Option<String>,
    /// Remote OS hint: "linux", "macos", "windows", "freebsd".
    pub os_type: Option<String>,

    // Connection behaviour
    /// Shell command to execute automatically after the shell opens.
    pub startup_command: Option<String>,
    /// ProxyJump / bastion host in `user@host:port` form.
    pub proxy_jump: Option<String>,
    /// Id of another saved host to tunnel through (ProxyJump). When set, the
    /// connection is established by first opening an SSH session to this jump
    /// host and tunnelling a `direct-tcpip` channel to the target. Takes
    /// precedence over the free-text `proxy_jump` field above.
    pub proxy_jump_host_id: Option<String>,
    /// Initial remote directory the file browser opens in for this host. When
    /// unset the browser falls back to the server-reported home directory. A
    /// leading `~` is expanded against the home directory by the frontend.
    pub start_directory: Option<String>,
    /// Seconds between SSH keepalive pings (0 = disabled).
    pub keep_alive_interval: Option<u32>,
    /// Default login shell, e.g. "/bin/zsh".
    pub default_shell: Option<String>,

    // Terminal per-host overrides
    /// Terminal font-size override for this host.
    pub font_size: Option<u32>,

    // Usage statistics (updated automatically by record_connection)
    /// ISO-8601 timestamp of the most-recent successful connection.
    pub last_connected_at: Option<String>,
    /// Running total of successful connections to this host.
    pub connection_count: Option<u32>,
}

/// A named group that hosts can be assigned to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostGroup {
    pub id: String,
    pub name: String,
    /// Hex colour string used for the group icon in the UI (e.g. `#6366f1`).
    pub color: String,
    /// Lucide icon name for the group (e.g. "Folder", "Cloud", "Server").
    pub icon: Option<String>,
    pub sort_order: i32,
    pub default_username: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Database handle
// ---------------------------------------------------------------------------

/// Thin wrapper around a SQLite connection.
///
/// `rusqlite::Connection` is `!Send`, so we guard it with `std::sync::Mutex`
/// and expose only synchronous methods.  Callers that need async behaviour
/// must use `tokio::task::spawn_blocking`.
pub struct HostDb {
    conn: Mutex<Connection>,
}

impl HostDb {
    /// Opens (or creates) the SQLite database at `<app_data_dir>/anyscp.db`
    /// and runs schema migrations.
    #[instrument(skip_all, fields(dir = %app_data_dir.display()))]
    pub fn new(app_data_dir: &std::path::Path) -> Result<Self, DbError> {
        std::fs::create_dir_all(app_data_dir).map_err(|e| {
            DbError::InitError(format!(
                "could not create app data directory {}: {e}",
                app_data_dir.display()
            ))
        })?;

        let db_path = app_data_dir.join("anyscp.db");
        let conn = Connection::open(&db_path).map_err(|e| {
            DbError::InitError(format!(
                "could not open database at {}: {e}",
                db_path.display()
            ))
        })?;

        // Enable WAL mode for better concurrent read performance.
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| DbError::InitError(format!("could not set PRAGMAs: {e}")))?;

        // Bootstrap the _meta table used by the migration system.
        conn.execute_batch("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);")
            .map_err(|e| DbError::InitError(format!("could not create _meta table: {e}")))?;

        Self::run_migrations(&conn)
            .map_err(|e| DbError::InitError(format!("could not run migrations: {e}")))?;

        tracing::info!(path = %db_path.display(), "database initialised");

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    // -----------------------------------------------------------------------
    // Migrations
    // -----------------------------------------------------------------------

    /// Reads the current schema version from `_meta` and applies every
    /// pending migration in order.  Each migration increments the version
    /// atomically so a crash mid-way is safe to resume.
    fn run_migrations(conn: &Connection) -> Result<(), DbError> {
        let version: i64 = conn
            .query_row(
                "SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM _meta WHERE key = 'schema_version'), 0)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        if version < 1 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS saved_hosts (
                    id          TEXT PRIMARY KEY,
                    label       TEXT NOT NULL,
                    host        TEXT NOT NULL,
                    port        INTEGER NOT NULL DEFAULT 22,
                    username    TEXT NOT NULL,
                    auth_type   TEXT NOT NULL,
                    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '1');",
            )?;
            tracing::info!("migration 0→1 applied: created saved_hosts");
        }

        if version < 2 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS host_groups (
                    id               TEXT PRIMARY KEY,
                    name             TEXT NOT NULL,
                    color            TEXT NOT NULL DEFAULT '#6366f1',
                    sort_order       INTEGER NOT NULL DEFAULT 0,
                    default_username TEXT,
                    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
                );
                ALTER TABLE saved_hosts ADD COLUMN group_id TEXT REFERENCES host_groups(id) ON DELETE SET NULL;
                INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '2');",
            )?;
            tracing::info!("migration 1→2 applied: added host_groups + saved_hosts.group_id");
        }

        if version < 3 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS connection_history (
                    id           INTEGER PRIMARY KEY AUTOINCREMENT,
                    host_id      TEXT NOT NULL REFERENCES saved_hosts(id) ON DELETE CASCADE,
                    connected_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE INDEX IF NOT EXISTS idx_history_connected_at
                    ON connection_history(connected_at DESC);
                INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '3');",
            )?;
            tracing::info!("migration 2→3 applied: created connection_history");
        }

        if version < 4 {
            // SQLite requires one ALTER TABLE per statement.
            conn.execute("ALTER TABLE saved_hosts ADD COLUMN key_path TEXT", [])?;
            conn.execute("ALTER TABLE saved_hosts ADD COLUMN color TEXT", [])?;
            conn.execute("ALTER TABLE saved_hosts ADD COLUMN notes TEXT", [])?;
            conn.execute("ALTER TABLE saved_hosts ADD COLUMN environment TEXT", [])?;
            conn.execute("ALTER TABLE saved_hosts ADD COLUMN os_type TEXT", [])?;
            conn.execute(
                "ALTER TABLE saved_hosts ADD COLUMN startup_command TEXT",
                [],
            )?;
            conn.execute("ALTER TABLE saved_hosts ADD COLUMN proxy_jump TEXT", [])?;
            conn.execute(
                "ALTER TABLE saved_hosts ADD COLUMN keep_alive_interval INTEGER",
                [],
            )?;
            conn.execute("ALTER TABLE saved_hosts ADD COLUMN default_shell TEXT", [])?;
            conn.execute("ALTER TABLE saved_hosts ADD COLUMN font_size INTEGER", [])?;
            conn.execute(
                "ALTER TABLE saved_hosts ADD COLUMN last_connected_at TEXT",
                [],
            )?;
            conn.execute(
                "ALTER TABLE saved_hosts ADD COLUMN connection_count INTEGER DEFAULT 0",
                [],
            )?;
            conn.execute(
                "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '4')",
                [],
            )?;
            tracing::info!("migration 3→4 applied: added 12 new columns to saved_hosts");
        }

        if version < 5 {
            conn.execute("ALTER TABLE host_groups ADD COLUMN icon TEXT", [])?;
            conn.execute(
                "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '5')",
                [],
            )?;
            tracing::info!("migration 4→5 applied: added icon column to host_groups");
        }

        if version < 6 {
            // 1. Base tables
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS snippet_folders (
                    id         TEXT PRIMARY KEY,
                    name       TEXT NOT NULL,
                    parent_id  TEXT REFERENCES snippet_folders(id) ON DELETE CASCADE,
                    color      TEXT,
                    icon       TEXT,
                    sort_order INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                CREATE TABLE IF NOT EXISTS snippets (
                    id            TEXT PRIMARY KEY,
                    name          TEXT NOT NULL,
                    command       TEXT NOT NULL,
                    description   TEXT,
                    folder_id     TEXT REFERENCES snippet_folders(id) ON DELETE SET NULL,
                    tags          TEXT,
                    variables     TEXT,
                    is_dangerous  INTEGER NOT NULL DEFAULT 0,
                    use_count     INTEGER NOT NULL DEFAULT 0,
                    last_used_at  TEXT,
                    sort_order    INTEGER NOT NULL DEFAULT 0,
                    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
                );",
            )?;

            // 2. FTS5 virtual table (must be a separate execute_batch call)
            conn.execute_batch(
                "CREATE VIRTUAL TABLE IF NOT EXISTS snippets_fts USING fts5(
                    name, command, description, tags,
                    content='snippets',
                    content_rowid='rowid'
                );",
            )?;

            // 3. Triggers — each as its own execute_batch to avoid parse ambiguity
            conn.execute_batch(
                "CREATE TRIGGER IF NOT EXISTS snippets_ai AFTER INSERT ON snippets BEGIN
                    INSERT INTO snippets_fts(rowid, name, command, description, tags)
                    VALUES (new.rowid, new.name, new.command, new.description, new.tags);
                END;",
            )?;

            conn.execute_batch(
                "CREATE TRIGGER IF NOT EXISTS snippets_ad AFTER DELETE ON snippets BEGIN
                    INSERT INTO snippets_fts(snippets_fts, rowid, name, command, description, tags)
                    VALUES ('delete', old.rowid, old.name, old.command, old.description, old.tags);
                END;",
            )?;

            conn.execute_batch(
                "CREATE TRIGGER IF NOT EXISTS snippets_au AFTER UPDATE ON snippets BEGIN
                    INSERT INTO snippets_fts(snippets_fts, rowid, name, command, description, tags)
                    VALUES ('delete', old.rowid, old.name, old.command, old.description, old.tags);
                    INSERT INTO snippets_fts(rowid, name, command, description, tags)
                    VALUES (new.rowid, new.name, new.command, new.description, new.tags);
                END;",
            )?;

            // 4. Bump schema version
            conn.execute(
                "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '6')",
                [],
            )?;

            tracing::info!(
                "migration 5→6 applied: created snippet_folders, snippets, FTS5, triggers"
            );
        }

        if version < 7 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS app_settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '7');",
            )?;
            tracing::info!("migration 6→7 applied: created app_settings");
        }

        if version < 8 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS port_forwarding_rules (
                    id            TEXT PRIMARY KEY,
                    host_id       TEXT REFERENCES saved_hosts(id) ON DELETE CASCADE,
                    label         TEXT,
                    forward_type  TEXT NOT NULL DEFAULT 'local',
                    bind_address  TEXT NOT NULL DEFAULT '127.0.0.1',
                    local_port    INTEGER NOT NULL,
                    remote_host   TEXT NOT NULL DEFAULT 'localhost',
                    remote_port   INTEGER NOT NULL,
                    auto_start    INTEGER NOT NULL DEFAULT 0,
                    enabled       INTEGER NOT NULL DEFAULT 1,
                    sort_order    INTEGER NOT NULL DEFAULT 0,
                    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '8');",
            )?;
            tracing::info!("migration 7→8 applied: created port_forwarding_rules");
        }

        if version < 9 {
            conn.execute_batch(
                "ALTER TABLE port_forwarding_rules ADD COLUMN description TEXT;
                 ALTER TABLE port_forwarding_rules ADD COLUMN last_used_at TEXT;
                 ALTER TABLE port_forwarding_rules ADD COLUMN total_bytes INTEGER NOT NULL DEFAULT 0;
                 INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '9');",
            )?;
            tracing::info!("migration 8→9 applied: added description, last_used_at, total_bytes to port_forwarding_rules");
        }

        if version < 10 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS s3_connections (
                    id          TEXT PRIMARY KEY,
                    label       TEXT NOT NULL,
                    provider    TEXT NOT NULL DEFAULT 'aws',
                    region      TEXT NOT NULL,
                    endpoint    TEXT,
                    bucket      TEXT,
                    path_style  INTEGER NOT NULL DEFAULT 0,
                    group_id    TEXT,
                    color       TEXT,
                    environment TEXT,
                    notes       TEXT,
                    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '10');",
            )?;
            tracing::info!("migration 9→10 applied: created s3_connections");
        }

        if version < 11 {
            // Add columns that may be missing if migration 10 ran before they were added
            let has_color: bool = conn
                .prepare("SELECT color FROM s3_connections LIMIT 0")
                .is_ok();
            if !has_color {
                conn.execute_batch(
                    "ALTER TABLE s3_connections ADD COLUMN color TEXT;
                     ALTER TABLE s3_connections ADD COLUMN environment TEXT;
                     ALTER TABLE s3_connections ADD COLUMN notes TEXT;",
                )?;
            }
            conn.execute_batch(
                "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '11');",
            )?;
            tracing::info!(
                "migration 10→11 applied: ensured color, environment, notes on s3_connections"
            );
        }

        if version < 12 {
            // Idempotent: only add the column if it doesn't already exist.
            let has_proxy_jump_host_id: bool = conn
                .prepare("SELECT proxy_jump_host_id FROM saved_hosts LIMIT 0")
                .is_ok();
            if !has_proxy_jump_host_id {
                conn.execute(
                    "ALTER TABLE saved_hosts ADD COLUMN proxy_jump_host_id TEXT REFERENCES saved_hosts(id) ON DELETE SET NULL",
                    [],
                )?;
            }
            conn.execute(
                "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '12')",
                [],
            )?;
            tracing::info!("migration 11→12 applied: added saved_hosts.proxy_jump_host_id");
        }

        if version < 13 {
            // Idempotent: only add the column if it doesn't already exist.
            let has_start_directory: bool = conn
                .prepare("SELECT start_directory FROM saved_hosts LIMIT 0")
                .is_ok();
            if !has_start_directory {
                conn.execute(
                    "ALTER TABLE saved_hosts ADD COLUMN start_directory TEXT",
                    [],
                )?;
            }
            conn.execute(
                "INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', '13')",
                [],
            )?;
            tracing::info!("migration 12→13 applied: added saved_hosts.start_directory");
        }

        Ok(())
    }

    // -----------------------------------------------------------------------
    // SavedHost CRUD
    // -----------------------------------------------------------------------

    /// Upsert a host record.  If a row with the same `id` already exists it
    /// is fully replaced; `created_at` is preserved by the caller-supplied value.
    ///
    /// This is the raw write with no ProxyJump validation — use
    /// [`save_host_validated`](Self::save_host_validated) for the user-facing save
    /// path that must reject cycles. This variant is retained for callers that
    /// either don't set `proxy_jump_host_id` (e.g. the first pass of an import) or
    /// validate separately.
    #[instrument(skip(self), fields(id = %host.id))]
    pub fn save_host(&self, host: &SavedHost) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        Self::upsert_host(&conn, host)?;
        Ok(())
    }

    /// Upsert a host, atomically rejecting ProxyJump configurations that would
    /// form a cycle (`A → B → A`), a self-reference (`A → A`), or point at a
    /// non-existent tunnel host. The chain walk and the write share a single
    /// `IMMEDIATE` transaction so a concurrent writer cannot slip a cycle in
    /// between the check and the write (closing the TOCTOU window).
    #[instrument(skip(self), fields(id = %host.id))]
    pub fn save_host_validated(&self, host: &SavedHost) -> Result<(), DbError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        Self::check_proxy_jump_chain(&tx, &host.id, host.proxy_jump_host_id.as_deref())?;
        Self::upsert_host(&tx, host)?;
        tx.commit()?;
        Ok(())
    }

    /// Walk the ProxyJump chain starting at `proxy` (the proposed
    /// `proxy_jump_host_id` for `host_id`) and reject self-references, cycles, and
    /// dangling immediate targets. Operates on a single connection/transaction so
    /// it can be composed atomically with a write. The walk is bounded so a
    /// pre-existing corrupt chain can never loop forever.
    fn check_proxy_jump_chain(
        conn: &Connection,
        host_id: &str,
        proxy: Option<&str>,
    ) -> Result<(), DbError> {
        let Some(first) = proxy.filter(|s| !s.is_empty()) else {
            return Ok(());
        };
        if first == host_id {
            return Err(DbError::Validation(
                "A host cannot tunnel through itself".to_string(),
            ));
        }

        // The immediate target must exist — otherwise the FK would reject the
        // write with an opaque error. Surface a friendly message instead.
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM saved_hosts WHERE id = ?1",
                params![first],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if !exists {
            return Err(DbError::Validation(
                "The selected tunnel host no longer exists".to_string(),
            ));
        }

        let mut current = Some(first.to_string());
        // Bound the walk to avoid runaway loops on pre-existing corrupt chains.
        for _ in 0..64 {
            let Some(cid) = current else { return Ok(()) };
            if cid == host_id {
                return Err(DbError::Validation(
                    "Circular tunnel configuration detected".to_string(),
                ));
            }
            current = conn
                .query_row(
                    "SELECT proxy_jump_host_id FROM saved_hosts WHERE id = ?1",
                    params![cid],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten()
                .filter(|s| !s.is_empty());
        }
        Ok(())
    }

    /// Shared upsert used by both the raw and validated save paths. Takes a bare
    /// connection so it can run inside a transaction.
    fn upsert_host(conn: &Connection, host: &SavedHost) -> Result<(), DbError> {
        conn.execute(
            "INSERT INTO saved_hosts (
                 id, label, host, port, username, auth_type, group_id, created_at, updated_at,
                 key_path, color, notes, environment, os_type,
                 startup_command, proxy_jump, keep_alive_interval, default_shell,
                 font_size, last_connected_at, connection_count, proxy_jump_host_id,
                 start_directory
             )
             VALUES (
                 ?1,  ?2,  ?3,  ?4,  ?5,  ?6,  ?7,  ?8,  ?9,
                 ?10, ?11, ?12, ?13, ?14,
                 ?15, ?16, ?17, ?18,
                 ?19, ?20, ?21, ?22,
                 ?23
             )
             ON CONFLICT(id) DO UPDATE SET
                 label                = excluded.label,
                 host                 = excluded.host,
                 port                 = excluded.port,
                 username             = excluded.username,
                 auth_type            = excluded.auth_type,
                 group_id             = excluded.group_id,
                 updated_at           = excluded.updated_at,
                 key_path             = excluded.key_path,
                 color                = excluded.color,
                 notes                = excluded.notes,
                 environment          = excluded.environment,
                 os_type              = excluded.os_type,
                 startup_command      = excluded.startup_command,
                 proxy_jump           = excluded.proxy_jump,
                 keep_alive_interval  = excluded.keep_alive_interval,
                 default_shell        = excluded.default_shell,
                 font_size            = excluded.font_size,
                 last_connected_at    = excluded.last_connected_at,
                 connection_count     = excluded.connection_count,
                 proxy_jump_host_id   = excluded.proxy_jump_host_id,
                 start_directory      = excluded.start_directory",
            params![
                host.id,
                host.label,
                host.host,
                host.port,
                host.username,
                host.auth_type,
                host.group_id,
                host.created_at,
                host.updated_at,
                host.key_path,
                host.color,
                host.notes,
                host.environment,
                host.os_type,
                host.startup_command,
                host.proxy_jump,
                host.keep_alive_interval,
                host.default_shell,
                host.font_size,
                host.last_connected_at,
                host.connection_count,
                host.proxy_jump_host_id,
                host.start_directory,
            ],
        )?;
        Ok(())
    }

    /// Return all saved hosts ordered by label ascending.
    #[instrument(skip(self))]
    pub fn list_hosts(&self) -> Result<Vec<SavedHost>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let mut stmt = conn.prepare(
            "SELECT id, label, host, port, username, auth_type, group_id, created_at, updated_at,
                    key_path, color, notes, environment, os_type,
                    startup_command, proxy_jump, keep_alive_interval, default_shell,
                    font_size, last_connected_at, connection_count, proxy_jump_host_id,
                    start_directory
             FROM saved_hosts
             ORDER BY label ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(SavedHost {
                id: row.get(0)?,
                label: row.get(1)?,
                host: row.get(2)?,
                port: row.get::<_, u32>(3)? as u16,
                username: row.get(4)?,
                auth_type: row.get(5)?,
                group_id: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                key_path: row.get(9)?,
                color: row.get(10)?,
                notes: row.get(11)?,
                environment: row.get(12)?,
                os_type: row.get(13)?,
                startup_command: row.get(14)?,
                proxy_jump: row.get(15)?,
                keep_alive_interval: row.get(16)?,
                default_shell: row.get(17)?,
                font_size: row.get(18)?,
                last_connected_at: row.get(19)?,
                connection_count: row.get(20)?,
                proxy_jump_host_id: row.get(21)?,
                start_directory: row.get(22)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    /// Delete a host by its UUID string.  Returns `DbError::NotFound` when no
    /// row matched so callers can surface a meaningful error to the frontend.
    #[instrument(skip(self), fields(id = %id))]
    pub fn delete_host(&self, id: &str) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let affected = conn.execute("DELETE FROM saved_hosts WHERE id = ?1", params![id])?;
        if affected == 0 {
            return Err(DbError::NotFound(id.to_string()));
        }
        Ok(())
    }

    /// Look up a single host by id.  Returns `None` when not found (no error),
    /// consistent with Rust conventions for optional lookups.
    #[instrument(skip(self), fields(id = %id))]
    pub fn get_host(&self, id: &str) -> Result<Option<SavedHost>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let mut stmt = conn.prepare(
            "SELECT id, label, host, port, username, auth_type, group_id, created_at, updated_at,
                    key_path, color, notes, environment, os_type,
                    startup_command, proxy_jump, keep_alive_interval, default_shell,
                    font_size, last_connected_at, connection_count, proxy_jump_host_id,
                    start_directory
             FROM saved_hosts
             WHERE id = ?1",
        )?;

        let mut rows = stmt.query_map(params![id], |row| {
            Ok(SavedHost {
                id: row.get(0)?,
                label: row.get(1)?,
                host: row.get(2)?,
                port: row.get::<_, u32>(3)? as u16,
                username: row.get(4)?,
                auth_type: row.get(5)?,
                group_id: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
                key_path: row.get(9)?,
                color: row.get(10)?,
                notes: row.get(11)?,
                environment: row.get(12)?,
                os_type: row.get(13)?,
                startup_command: row.get(14)?,
                proxy_jump: row.get(15)?,
                keep_alive_interval: row.get(16)?,
                default_shell: row.get(17)?,
                font_size: row.get(18)?,
                last_connected_at: row.get(19)?,
                connection_count: row.get(20)?,
                proxy_jump_host_id: row.get(21)?,
                start_directory: row.get(22)?,
            })
        })?;

        match rows.next() {
            Some(Ok(host)) => Ok(Some(host)),
            Some(Err(e)) => Err(DbError::from(e)),
            None => Ok(None),
        }
    }

    /// Link `id` to tunnel through `jump_id`, atomically rejecting links that
    /// would form a cycle or self-reference (the same guard the UI save path
    /// enforces). Used by the SSH-config import so a config with mutually
    /// referencing `ProxyJump` directives cannot persist a connect-breaking cycle.
    /// Returns `DbError::Validation` on a cycle/self-reference and
    /// `DbError::NotFound` if `id` does not exist.
    #[instrument(skip(self), fields(id = %id))]
    pub fn set_proxy_jump_host_validated(&self, id: &str, jump_id: &str) -> Result<(), DbError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        Self::check_proxy_jump_chain(&tx, id, Some(jump_id))?;
        let affected = tx.execute(
            "UPDATE saved_hosts SET proxy_jump_host_id = ?2, updated_at = datetime('now') WHERE id = ?1",
            params![id, jump_id],
        )?;
        if affected == 0 {
            return Err(DbError::NotFound(id.to_string()));
        }
        tx.commit()?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Connection history
    // -----------------------------------------------------------------------

    /// Record a successful connection for `host_id` and prune the table so
    /// it never exceeds 500 rows total.
    #[instrument(skip(self), fields(host_id = %host_id))]
    pub fn record_connection(&self, host_id: &str) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        conn.execute(
            "INSERT INTO connection_history (host_id) VALUES (?1)",
            params![host_id],
        )?;
        // Update per-host usage statistics.
        conn.execute(
            "UPDATE saved_hosts
             SET last_connected_at = datetime('now'),
                 connection_count  = COALESCE(connection_count, 0) + 1
             WHERE id = ?1",
            params![host_id],
        )?;
        // Prune: keep only the 500 most-recent rows by autoincrement id.
        conn.execute(
            "DELETE FROM connection_history
             WHERE id NOT IN (
                 SELECT id FROM connection_history ORDER BY id DESC LIMIT 500
             )",
            [],
        )?;
        Ok(())
    }

    /// Return the most-recent distinct connection per host, joined with
    /// `saved_hosts` for display fields.  At most `limit` rows are returned,
    /// ordered newest-first.
    #[instrument(skip(self), fields(limit = %limit))]
    pub fn list_recent_connections(&self, limit: u32) -> Result<Vec<RecentConnection>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        // For each host_id select only the single most-recent connected_at,
        // then join with saved_hosts and sort the result set newest-first.
        let mut stmt = conn.prepare(
            "SELECT h.id, h.label, h.host, h.port, h.username, c.connected_at
             FROM saved_hosts h
             INNER JOIN (
                 SELECT host_id, MAX(connected_at) AS connected_at
                 FROM connection_history
                 GROUP BY host_id
             ) c ON c.host_id = h.id
             ORDER BY c.connected_at DESC
             LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit], |row| {
            Ok(RecentConnection {
                host_id: row.get(0)?,
                host_label: row.get(1)?,
                host: row.get(2)?,
                port: row.get::<_, u32>(3)? as u16,
                username: row.get(4)?,
                connected_at: row.get(5)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    /// Return all connection history entries (not deduplicated), with pagination.
    pub fn list_connection_history(
        &self,
        host_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<ConnectionHistoryEntry>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;

        if let Some(hid) = host_id {
            let mut stmt = conn.prepare(
                "SELECT c.id, h.id, h.label, h.host, h.port, h.username, c.connected_at
                 FROM connection_history c
                 INNER JOIN saved_hosts h ON h.id = c.host_id
                 WHERE c.host_id = ?1
                 ORDER BY c.connected_at DESC
                 LIMIT ?2 OFFSET ?3",
            )?;
            let rows = stmt.query_map(params![hid, limit, offset], Self::map_history_row)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        } else {
            let mut stmt = conn.prepare(
                "SELECT c.id, h.id, h.label, h.host, h.port, h.username, c.connected_at
                 FROM connection_history c
                 INNER JOIN saved_hosts h ON h.id = c.host_id
                 ORDER BY c.connected_at DESC
                 LIMIT ?1 OFFSET ?2",
            )?;
            let rows = stmt.query_map(params![limit, offset], Self::map_history_row)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        }
    }

    fn map_history_row(row: &rusqlite::Row) -> rusqlite::Result<ConnectionHistoryEntry> {
        Ok(ConnectionHistoryEntry {
            id: row.get(0)?,
            host_id: row.get(1)?,
            host_label: row.get(2)?,
            host: row.get(3)?,
            port: row.get::<_, u32>(4)? as u16,
            username: row.get(5)?,
            connected_at: row.get(6)?,
        })
    }

    // -----------------------------------------------------------------------
    // HostGroup CRUD
    // -----------------------------------------------------------------------

    /// Insert a new group record.
    #[instrument(skip(self), fields(id = %group.id))]
    pub fn create_group(&self, group: &HostGroup) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        conn.execute(
            "INSERT INTO host_groups (id, name, color, icon, sort_order, default_username, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                group.id,
                group.name,
                group.color,
                group.icon,
                group.sort_order,
                group.default_username,
                group.created_at,
                group.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Update an existing group record.  All mutable fields are replaced.
    #[instrument(skip(self), fields(id = %group.id))]
    pub fn update_group(&self, group: &HostGroup) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let affected = conn.execute(
            "UPDATE host_groups
             SET name             = ?2,
                 color            = ?3,
                 icon             = ?4,
                 sort_order       = ?5,
                 default_username = ?6,
                 updated_at       = ?7
             WHERE id = ?1",
            params![
                group.id,
                group.name,
                group.color,
                group.icon,
                group.sort_order,
                group.default_username,
                group.updated_at,
            ],
        )?;
        if affected == 0 {
            return Err(DbError::NotFound(group.id.clone()));
        }
        Ok(())
    }

    /// Return all groups ordered by `sort_order` ascending, then by name.
    #[instrument(skip(self))]
    pub fn list_groups(&self) -> Result<Vec<HostGroup>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, color, icon, sort_order, default_username, created_at, updated_at
             FROM host_groups
             ORDER BY sort_order ASC, name ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(HostGroup {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                icon: row.get(3)?,
                sort_order: row.get(4)?,
                default_username: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    /// Delete a group by id.  Due to the `ON DELETE SET NULL` foreign-key
    /// constraint, any hosts that belonged to this group are orphaned (their
    /// `group_id` is set to NULL) rather than deleted.
    #[instrument(skip(self), fields(id = %id))]
    pub fn delete_group(&self, id: &str) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let affected = conn.execute("DELETE FROM host_groups WHERE id = ?1", params![id])?;
        if affected == 0 {
            return Err(DbError::NotFound(id.to_string()));
        }
        Ok(())
    }

    /// Delete a group and ALL hosts that belong to it.
    #[instrument(skip(self), fields(id = %id))]
    pub fn delete_group_with_hosts(&self, id: &str) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        // Delete hosts first (before the group, since FK is ON DELETE SET NULL)
        conn.execute("DELETE FROM saved_hosts WHERE group_id = ?1", params![id])?;
        let affected = conn.execute("DELETE FROM host_groups WHERE id = ?1", params![id])?;
        if affected == 0 {
            return Err(DbError::NotFound(id.to_string()));
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Snippet CRUD
    // -----------------------------------------------------------------------

    /// Upsert a snippet.  If a row with the same `id` already exists it is
    /// fully replaced; `created_at` is preserved by the caller-supplied value.
    #[instrument(skip(self), fields(id = %snippet.id))]
    pub fn save_snippet(&self, snippet: &Snippet) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        conn.execute(
            "INSERT INTO snippets (
                 id, name, command, description, folder_id, tags, variables,
                 is_dangerous, use_count, last_used_at, sort_order, created_at, updated_at
             )
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET
                 name         = excluded.name,
                 command      = excluded.command,
                 description  = excluded.description,
                 folder_id    = excluded.folder_id,
                 tags         = excluded.tags,
                 variables    = excluded.variables,
                 is_dangerous = excluded.is_dangerous,
                 use_count    = excluded.use_count,
                 last_used_at = excluded.last_used_at,
                 sort_order   = excluded.sort_order,
                 updated_at   = excluded.updated_at",
            params![
                snippet.id,
                snippet.name,
                snippet.command,
                snippet.description,
                snippet.folder_id,
                snippet.tags,
                snippet.variables,
                snippet.is_dangerous as i32,
                snippet.use_count,
                snippet.last_used_at,
                snippet.sort_order,
                snippet.created_at,
                snippet.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Look up a single snippet by id.  Returns `None` when not found.
    #[instrument(skip(self), fields(id = %id))]
    pub fn get_snippet(&self, id: &str) -> Result<Option<Snippet>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, command, description, folder_id, tags, variables,
                    is_dangerous, use_count, last_used_at, sort_order, created_at, updated_at
             FROM snippets
             WHERE id = ?1",
        )?;

        let mut rows = stmt.query_map(params![id], |row| {
            Ok(Snippet {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                description: row.get(3)?,
                folder_id: row.get(4)?,
                tags: row.get(5)?,
                variables: row.get(6)?,
                is_dangerous: row.get::<_, i32>(7)? != 0,
                use_count: row.get::<_, u32>(8)?,
                last_used_at: row.get(9)?,
                sort_order: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        })?;

        match rows.next() {
            Some(Ok(s)) => Ok(Some(s)),
            Some(Err(e)) => Err(DbError::from(e)),
            None => Ok(None),
        }
    }

    /// Return snippets, optionally filtered by `folder_id`.
    ///
    /// Pass `None` to return all snippets across all folders.  Results are
    /// ordered by `sort_order ASC, name ASC`.
    #[instrument(skip(self), fields(folder_id = ?folder_id))]
    pub fn list_snippets(&self, folder_id: Option<&str>) -> Result<Vec<Snippet>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;

        let sql = if folder_id.is_some() {
            "SELECT id, name, command, description, folder_id, tags, variables,
                    is_dangerous, use_count, last_used_at, sort_order, created_at, updated_at
             FROM snippets
             WHERE folder_id = ?1
             ORDER BY sort_order ASC, name ASC"
        } else {
            "SELECT id, name, command, description, folder_id, tags, variables,
                    is_dangerous, use_count, last_used_at, sort_order, created_at, updated_at
             FROM snippets
             ORDER BY sort_order ASC, name ASC"
        };

        let mut stmt = conn.prepare(sql)?;

        let map_row = |row: &rusqlite::Row<'_>| {
            Ok(Snippet {
                id: row.get(0)?,
                name: row.get(1)?,
                command: row.get(2)?,
                description: row.get(3)?,
                folder_id: row.get(4)?,
                tags: row.get(5)?,
                variables: row.get(6)?,
                is_dangerous: row.get::<_, i32>(7)? != 0,
                use_count: row.get::<_, u32>(8)?,
                last_used_at: row.get(9)?,
                sort_order: row.get(10)?,
                created_at: row.get(11)?,
                updated_at: row.get(12)?,
            })
        };

        let rows = if let Some(fid) = folder_id {
            stmt.query_map(params![fid], map_row)?
        } else {
            stmt.query_map([], map_row)?
        };

        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    /// Delete a snippet by its UUID string.  Returns `DbError::NotFound` when
    /// no row matched.
    #[instrument(skip(self), fields(id = %id))]
    pub fn delete_snippet(&self, id: &str) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let affected = conn.execute("DELETE FROM snippets WHERE id = ?1", params![id])?;
        if affected == 0 {
            return Err(DbError::NotFound(id.to_string()));
        }
        Ok(())
    }

    /// Increment `use_count` and update `last_used_at` for the given snippet.
    #[instrument(skip(self), fields(id = %id))]
    pub fn record_snippet_use(&self, id: &str) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        conn.execute(
            "UPDATE snippets
             SET use_count    = use_count + 1,
                 last_used_at = datetime('now')
             WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Full-text search over snippets using the FTS5 index.
    ///
    /// Each whitespace-separated token in `query` is turned into a prefix
    /// match (e.g. `"git log"` → `"git* log*"`), which gives instant
    /// typeahead results.  Results are ordered by FTS rank (best match first)
    /// and capped at `limit` rows.
    #[instrument(skip(self), fields(query = %query, limit = %limit))]
    pub fn search_snippets(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<SnippetSearchResult>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;

        // Build FTS5 prefix query: "git log" → "git* log*"
        let fts_query = query
            .split_whitespace()
            .map(|w| format!("{}*", w))
            .collect::<Vec<_>>()
            .join(" ");

        let mut stmt = conn.prepare(
            "SELECT s.id, s.name, s.command, s.description, s.folder_id, s.tags, s.variables,
                    s.is_dangerous, s.use_count, s.last_used_at, s.sort_order,
                    s.created_at, s.updated_at,
                    snippets_fts.rank
             FROM snippets s
             JOIN snippets_fts ON s.rowid = snippets_fts.rowid
             WHERE snippets_fts MATCH ?1
             ORDER BY snippets_fts.rank
             LIMIT ?2",
        )?;

        let rows = stmt.query_map(params![fts_query, limit], |row| {
            Ok(SnippetSearchResult {
                snippet: Snippet {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    command: row.get(2)?,
                    description: row.get(3)?,
                    folder_id: row.get(4)?,
                    tags: row.get(5)?,
                    variables: row.get(6)?,
                    is_dangerous: row.get::<_, i32>(7)? != 0,
                    use_count: row.get::<_, u32>(8)?,
                    last_used_at: row.get(9)?,
                    sort_order: row.get(10)?,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                },
                rank: row.get(13)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    // -----------------------------------------------------------------------
    // SnippetFolder CRUD
    // -----------------------------------------------------------------------

    /// Upsert a snippet folder.  If a row with the same `id` already exists
    /// it is fully replaced.
    #[instrument(skip(self), fields(id = %folder.id))]
    pub fn save_snippet_folder(&self, folder: &SnippetFolder) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        conn.execute(
            "INSERT INTO snippet_folders (id, name, parent_id, color, icon, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET
                 name       = excluded.name,
                 parent_id  = excluded.parent_id,
                 color      = excluded.color,
                 icon       = excluded.icon,
                 sort_order = excluded.sort_order,
                 updated_at = excluded.updated_at",
            params![
                folder.id,
                folder.name,
                folder.parent_id,
                folder.color,
                folder.icon,
                folder.sort_order,
                folder.created_at,
                folder.updated_at,
            ],
        )?;
        Ok(())
    }

    /// Return all snippet folders ordered by `sort_order ASC, name ASC`.
    #[instrument(skip(self))]
    pub fn list_snippet_folders(&self) -> Result<Vec<SnippetFolder>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let mut stmt = conn.prepare(
            "SELECT id, name, parent_id, color, icon, sort_order, created_at, updated_at
             FROM snippet_folders
             ORDER BY sort_order ASC, name ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(SnippetFolder {
                id: row.get(0)?,
                name: row.get(1)?,
                parent_id: row.get(2)?,
                color: row.get(3)?,
                icon: row.get(4)?,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    /// Delete a snippet folder by id.  Due to `ON DELETE CASCADE` on
    /// `snippet_folders.parent_id`, child sub-folders are also removed.
    /// Due to `ON DELETE SET NULL` on `snippets.folder_id`, snippets inside
    /// this folder are orphaned rather than deleted.
    #[instrument(skip(self), fields(id = %id))]
    pub fn delete_snippet_folder(&self, id: &str) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let affected = conn.execute("DELETE FROM snippet_folders WHERE id = ?1", params![id])?;
        if affected == 0 {
            return Err(DbError::NotFound(id.to_string()));
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // App Settings (key-value)
    // -----------------------------------------------------------------------

    /// Save a single setting. Upserts (insert or replace).
    pub fn save_setting(&self, key: &str, value: &str) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    /// Fetch a single setting by key. Returns `None` if the key is not present.
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let value = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(value)
    }

    // -----------------------------------------------------------------------
    // Port Forwarding Rules
    // -----------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn create_pf_rule(
        &self,
        id: &str,
        host_id: Option<&str>,
        label: Option<&str>,
        description: Option<&str>,
        forward_type: &str,
        bind_address: &str,
        local_port: u32,
        remote_host: &str,
        remote_port: u32,
        auto_start: bool,
    ) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        conn.execute(
            "INSERT INTO port_forwarding_rules (id, host_id, label, description, forward_type, bind_address, local_port, remote_host, remote_port, auto_start)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, host_id, label, description, forward_type, bind_address, local_port as i64, remote_host, remote_port as i64, auto_start as i32],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn update_pf_rule(
        &self,
        id: &str,
        label: Option<&str>,
        description: Option<&str>,
        bind_address: &str,
        local_port: u32,
        remote_host: &str,
        remote_port: u32,
        auto_start: bool,
    ) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let affected = conn.execute(
            "UPDATE port_forwarding_rules SET label=?2, description=?3, bind_address=?4, local_port=?5, remote_host=?6, remote_port=?7, auto_start=?8, updated_at=datetime('now') WHERE id=?1",
            params![id, label, description, bind_address, local_port as i64, remote_host, remote_port as i64, auto_start as i32],
        )?;
        if affected == 0 {
            return Err(DbError::NotFound(id.to_string()));
        }
        Ok(())
    }

    /// Update last_used_at timestamp for a rule.
    pub fn touch_pf_rule(&self, id: &str) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        conn.execute(
            "UPDATE port_forwarding_rules SET last_used_at=datetime('now') WHERE id=?1",
            params![id],
        )?;
        Ok(())
    }

    pub fn delete_pf_rule(&self, id: &str) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let affected = conn.execute(
            "DELETE FROM port_forwarding_rules WHERE id = ?1",
            params![id],
        )?;
        if affected == 0 {
            return Err(DbError::NotFound(id.to_string()));
        }
        Ok(())
    }

    pub fn list_pf_rules(
        &self,
        host_id: Option<&str>,
    ) -> Result<Vec<crate::portforward::PortForwardRule>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let sql_all = "SELECT id, host_id, label, forward_type, bind_address, local_port, remote_host, remote_port, auto_start, enabled, created_at, description, last_used_at, total_bytes FROM port_forwarding_rules ORDER BY sort_order";
        let sql_host = "SELECT id, host_id, label, forward_type, bind_address, local_port, remote_host, remote_port, auto_start, enabled, created_at, description, last_used_at, total_bytes FROM port_forwarding_rules WHERE host_id = ?1 ORDER BY sort_order";

        if let Some(hid) = host_id {
            let mut stmt = conn.prepare(sql_host)?;
            let rows = stmt.query_map(params![hid], Self::map_pf_row)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        } else {
            let mut stmt = conn.prepare(sql_all)?;
            let rows = stmt.query_map([], Self::map_pf_row)?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        }
    }

    fn map_pf_row(row: &rusqlite::Row) -> rusqlite::Result<crate::portforward::PortForwardRule> {
        Ok(crate::portforward::PortForwardRule {
            id: row.get(0)?,
            host_id: row.get(1)?,
            label: row.get(2)?,
            forward_type: crate::portforward::ForwardType::from_str(&row.get::<_, String>(3)?),
            bind_address: row.get(4)?,
            local_port: row.get::<_, i64>(5)? as u32,
            remote_host: row.get(6)?,
            remote_port: row.get::<_, i64>(7)? as u32,
            auto_start: row.get::<_, i32>(8)? != 0,
            enabled: row.get::<_, i32>(9)? != 0,
            created_at: row.get(10)?,
            description: row.get(11)?,
            last_used_at: row.get(12)?,
            total_bytes: row.get::<_, i64>(13).unwrap_or(0) as u64,
        })
    }

    // -----------------------------------------------------------------------
    // S3 Connections
    // -----------------------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn save_s3_connection(
        &self,
        id: &str,
        label: &str,
        provider: &str,
        region: &str,
        endpoint: Option<&str>,
        bucket: Option<&str>,
        path_style: bool,
        group_id: Option<&str>,
        color: Option<&str>,
        environment: Option<&str>,
        notes: Option<&str>,
    ) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        conn.execute(
            "INSERT OR REPLACE INTO s3_connections (id, label, provider, region, endpoint, bucket, path_style, group_id, color, environment, notes, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))",
            params![id, label, provider, region, endpoint, bucket, path_style as i32, group_id, color, environment, notes],
        )?;
        Ok(())
    }

    pub fn list_s3_connections(&self) -> Result<Vec<crate::s3::S3Connection>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let mut stmt = conn.prepare(
            "SELECT id, label, provider, region, endpoint, bucket, path_style, group_id, color, environment, notes, created_at FROM s3_connections ORDER BY label"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(crate::s3::S3Connection {
                id: row.get(0)?,
                label: row.get(1)?,
                provider: row.get(2)?,
                region: row.get(3)?,
                endpoint: row.get(4)?,
                bucket: row.get(5)?,
                path_style: row.get::<_, i32>(6)? != 0,
                group_id: row.get(7)?,
                color: row.get(8)?,
                environment: row.get(9)?,
                notes: row.get(10)?,
                created_at: row.get(11)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn delete_s3_connection(&self, id: &str) -> Result<(), DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        conn.execute("DELETE FROM s3_connections WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Load all settings as a list of (key, value) pairs.
    pub fn load_all_settings(&self) -> Result<Vec<(String, String)>, DbError> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
        let mut stmt = conn.prepare("SELECT key, value FROM app_settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    // -----------------------------------------------------------------------
    // Factory reset
    // -----------------------------------------------------------------------

    /// Wipe ALL user data for a factory reset: every data table plus app
    /// settings. The schema (`_meta`/`schema_version`) and table structures are
    /// kept intact, so the database ends up identical to a fresh install — the
    /// next launch re-seeds first-run defaults (e.g. `editors_seeded`).
    ///
    /// Returns the host ids and S3 connection ids whose rows were removed so the
    /// caller can purge their secrets from the OS keychain — the `keyring` crate
    /// can't enumerate entries, so they must be deleted by key (see
    /// [`ResetKeys`]).
    #[instrument(skip(self))]
    pub fn factory_reset(&self) -> Result<ResetKeys, DbError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;

        // Collect the keychain keys before deleting the rows that reference them.
        let host_ids = conn
            .prepare("SELECT id FROM saved_hosts")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<String>, _>>()?;
        let s3_ids = conn
            .prepare("SELECT id FROM s3_connections")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<String>, _>>()?;

        // One transaction. `defer_foreign_keys` postpones FK checks to commit, so
        // we don't have to order deletes around the self-referential
        // `saved_hosts.proxy_jump_host_id` or the cross-table FKs. Deleting from
        // `snippets` fires the FTS triggers that keep `snippets_fts` consistent.
        let tx = conn.transaction()?;
        tx.execute_batch(
            "PRAGMA defer_foreign_keys = TRUE;
             DELETE FROM connection_history;
             DELETE FROM port_forwarding_rules;
             DELETE FROM s3_connections;
             DELETE FROM snippets;
             DELETE FROM snippet_folders;
             DELETE FROM saved_hosts;
             DELETE FROM host_groups;
             DELETE FROM app_settings;",
        )?;
        tx.commit()?;

        tracing::info!(
            hosts = host_ids.len(),
            s3 = s3_ids.len(),
            "factory reset: cleared all data and settings"
        );
        Ok(ResetKeys { host_ids, s3_ids })
    }

    // -----------------------------------------------------------------------
    // Backup snapshot (raw SQLite, full fidelity)
    // -----------------------------------------------------------------------

    /// Produce a consistent single-file SQLite snapshot of the entire database
    /// (every table, current schema) as raw bytes. `VACUUM INTO` is safe on a
    /// live WAL connection and yields a clean copy with no `-wal`/`-shm`
    /// sidecars. Used by the encrypted backup export.
    #[instrument(skip(self))]
    pub fn export_db_snapshot(&self) -> Result<Vec<u8>, DbError> {
        // The snapshot is plaintext on disk until the caller encrypts it, so it
        // lives inside an owner-only (0700) temp dir and is removed on every
        // path, including read failures.
        let dir = private_temp_dir("anyscp-export")?;
        let tmp = dir.join("snapshot.db");
        let result = (|| -> Result<Vec<u8>, DbError> {
            {
                let conn = self
                    .conn
                    .lock()
                    .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
                // VACUUM INTO doesn't accept bound parameters; the path is our own
                // uuid temp path, single-quote-escaped defensively.
                let escaped = tmp.to_string_lossy().replace('\'', "''");
                conn.execute_batch(&format!("VACUUM INTO '{escaped}'"))?;
            }
            std::fs::read(&tmp).map_err(|e| DbError::InitError(format!("read snapshot: {e}")))
        })();
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    /// Replace ALL data with the contents of a raw SQLite snapshot (as produced
    /// by [`export_db_snapshot`]). The incoming snapshot is migrated up to the
    /// current schema first, so older backups restore cleanly; a snapshot from
    /// a newer app version is rejected. The copy runs in one transaction with
    /// deferred FK checks; the snippets FTS index is rebuilt by the table
    /// triggers as rows are inserted.
    #[instrument(skip(self, bytes))]
    pub fn import_db_snapshot(&self, bytes: &[u8]) -> Result<(), DbError> {
        // The app's current schema version (main was migrated on startup).
        let current: i64 = {
            let conn = self
                .conn
                .lock()
                .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
            conn.query_row(
                "SELECT CAST(value AS INTEGER) FROM _meta WHERE key = 'schema_version'",
                [],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(0)
        };

        // Owner-only temp dir for the (plaintext) snapshot during restore.
        let tmp_dir = private_temp_dir("anyscp-restore")?;
        let tmp_db = tmp_dir.join("anyscp.db");

        let result = (|| -> Result<(), DbError> {
            std::fs::write(&tmp_db, bytes)
                .map_err(|e| DbError::InitError(format!("write snapshot: {e}")))?;

            // Validate the snapshot and migrate it up to the current schema.
            {
                let bak = Connection::open(&tmp_db)?;
                let bak_ver: i64 = bak
                    .query_row(
                        "SELECT CAST(value AS INTEGER) FROM _meta WHERE key = 'schema_version'",
                        [],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|_| {
                        DbError::Validation(
                            "this file is not a valid anySCP backup (no schema marker)".into(),
                        )
                    })?
                    .ok_or_else(|| {
                        DbError::Validation(
                            "this file is not a valid anySCP backup (no schema marker)".into(),
                        )
                    })?;
                if bak_ver > current {
                    return Err(DbError::Validation(format!(
                        "backup is from a newer version of anySCP (schema {bak_ver} > {current}); update anySCP first"
                    )));
                }
                bak.execute_batch("PRAGMA foreign_keys = ON;")?;
                Self::run_migrations(&bak)?;
                bak.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
            } // bak connection dropped (and checkpointed) here

            // Copy every table into the live database, replacing current data.
            let mut conn = self
                .conn
                .lock()
                .map_err(|e| DbError::InitError(format!("db lock poisoned: {e}")))?;
            conn.execute(
                "ATTACH DATABASE ?1 AS bak",
                params![tmp_db.to_string_lossy()],
            )?;
            let copy = (|| -> Result<(), DbError> {
                let tx = conn.transaction()?;
                tx.execute_batch("PRAGMA defer_foreign_keys = TRUE;")?;
                // Replace every table. Deferred FK checks mean delete/insert
                // order doesn't matter; the snippets FTS index is maintained by
                // its triggers as rows are inserted.
                //
                // Columns are listed explicitly, by NAME, read from the live
                // schema — `INSERT ... SELECT *` would map by position and could
                // silently mis-map if a future migration ever reordered columns.
                for table in COPYABLE_TABLES {
                    tx.execute(&format!("DELETE FROM main.{table}"), [])?;
                }
                for table in COPYABLE_TABLES {
                    let cols = table_columns(&tx, table)?;
                    if cols.is_empty() {
                        continue;
                    }
                    let list = cols.join(", ");
                    tx.execute(
                        &format!(
                            "INSERT INTO main.{table} ({list}) SELECT {list} FROM bak.{table}"
                        ),
                        [],
                    )?;
                }
                tx.commit()?;
                Ok(())
            })();
            // Always detach, even if the copy failed.
            let _ = conn.execute("DETACH DATABASE bak", []);
            copy
        })();

        let _ = std::fs::remove_dir_all(&tmp_dir);
        result
    }
}

/// Keychain keys whose secrets must be purged after a [`HostDb::factory_reset`].
/// Host credentials are keyed by `host_id`; S3 credentials by `s3:{id}`.
#[derive(Debug, Default)]
pub struct ResetKeys {
    pub host_ids: Vec<String>,
    pub s3_ids: Vec<String>,
}

/// Tables copied wholesale during a snapshot restore. `_meta` (schema marker)
/// is intentionally kept, and `snippets_fts*` shadow tables are excluded — they
/// are rebuilt by the snippets triggers as rows are inserted.
const COPYABLE_TABLES: &[&str] = &[
    "host_groups",
    "saved_hosts",
    "connection_history",
    "snippet_folders",
    "snippets",
    "port_forwarding_rules",
    "s3_connections",
    "app_settings",
];

/// Column names of `table` in declaration order, read from the live schema.
/// `table` is always a trusted constant from [`COPYABLE_TABLES`].
fn table_columns(conn: &Connection, table: &str) -> Result<Vec<String>, DbError> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let cols = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<String>, _>>()?;
    Ok(cols)
}

/// Create an owner-only (0700 on Unix) temp directory for a short-lived,
/// *plaintext* SQLite snapshot. The caller removes it when done.
fn private_temp_dir(prefix: &str) -> Result<std::path::PathBuf, DbError> {
    let dir = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| DbError::InitError(format!("temp dir: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| DbError::InitError(format!("temp dir perms: {e}")))?;
    }
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a HostDb in an isolated temp directory.  Returns the db and the
    /// path so the caller can keep the directory alive for the test duration.
    fn test_db() -> (HostDb, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("anyscp_test_{}", uuid::Uuid::new_v4()));
        let db = HostDb::new(&dir).expect("HostDb::new");
        (db, dir)
    }

    fn sample_host(id: &str) -> SavedHost {
        SavedHost {
            id: id.to_string(),
            label: format!("My Server {id}"),
            host: "192.0.2.1".to_string(),
            port: 22,
            username: "alice".to_string(),
            auth_type: "password".to_string(),
            group_id: None,
            created_at: "2026-01-01T00:00:00".to_string(),
            updated_at: "2026-01-01T00:00:00".to_string(),
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
            connection_count: Some(0),
        }
    }

    fn sample_group(id: &str) -> HostGroup {
        HostGroup {
            id: id.to_string(),
            name: format!("Group {id}"),
            color: "#6366f1".to_string(),
            icon: None,
            sort_order: 0,
            default_username: None,
            created_at: "2026-01-01T00:00:00".to_string(),
            updated_at: "2026-01-01T00:00:00".to_string(),
        }
    }

    #[test]
    fn round_trip_save_and_list() {
        let (db, _dir) = test_db();
        let h = sample_host("host-1");
        db.save_host(&h).expect("save_host");

        let all = db.list_hosts().expect("list_hosts");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "host-1");
        assert_eq!(all[0].port, 22);
        assert!(all[0].group_id.is_none());
    }

    #[test]
    fn factory_reset_wipes_everything_and_returns_keys() {
        let (db, _dir) = test_db();
        db.create_group(&sample_group("grp-1"))
            .expect("create_group");
        let mut h = sample_host("host-1");
        h.group_id = Some("grp-1".to_string());
        db.save_host(&h).expect("save_host");
        db.record_connection("host-1").expect("record_connection");
        db.save_setting("app_theme", "light").expect("save_setting");

        let keys = db.factory_reset().expect("factory_reset");
        assert_eq!(keys.host_ids, vec!["host-1".to_string()]);
        assert!(keys.s3_ids.is_empty());

        // Every data table and app settings are now empty.
        assert!(db.list_hosts().expect("list_hosts").is_empty());
        assert!(db.list_groups().expect("list_groups").is_empty());
        assert!(db.list_recent_connections(50).expect("recent").is_empty());
        assert!(db.load_all_settings().expect("settings").is_empty());

        // The schema survives the wipe — a fresh insert still works (i.e. the
        // DB is reset to first-launch state, not corrupted/dropped).
        db.save_host(&sample_host("host-2"))
            .expect("save after reset");
        assert_eq!(db.list_hosts().expect("list").len(), 1);
    }

    #[test]
    fn db_snapshot_export_import_roundtrip() {
        // Seed a source DB with a group + host (FK) + a setting, snapshot it.
        let (src, _d1) = test_db();
        src.create_group(&sample_group("g1")).expect("create_group");
        let mut h = sample_host("h1");
        h.group_id = Some("g1".to_string());
        src.save_host(&h).expect("save_host");
        src.save_setting("app_theme", "light")
            .expect("save_setting");
        src.save_snippet_folder(&sample_snippet_folder("sf1"))
            .expect("save_snippet_folder");
        src.save_snippet(&sample_snippet("s1"))
            .expect("save_snippet");
        let snapshot = src.export_db_snapshot().expect("export_db_snapshot");

        // Import into a separate, initially-empty DB.
        let (dst, _d2) = test_db();
        assert!(dst.list_hosts().expect("list").is_empty());
        dst.import_db_snapshot(&snapshot)
            .expect("import_db_snapshot");

        let hosts = dst.list_hosts().expect("list_hosts");
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].id, "h1");
        assert_eq!(hosts[0].group_id.as_deref(), Some("g1"));
        assert_eq!(dst.list_groups().expect("list_groups").len(), 1);
        assert!(dst
            .load_all_settings()
            .expect("settings")
            .iter()
            .any(|(k, v)| k == "app_theme" && v == "light"));
        // Snippets copy over, and the FTS index is rebuilt by the table triggers
        // during the ATTACH copy (search must find the snippet afterwards).
        assert_eq!(dst.list_snippets(None).expect("list_snippets").len(), 1);
        assert_eq!(dst.list_snippet_folders().expect("folders").len(), 1);
        assert!(
            !dst.search_snippets("shell", 10).expect("search").is_empty(),
            "FTS index should be populated after import"
        );
    }

    #[test]
    fn db_snapshot_import_replaces_existing() {
        let (src, _d1) = test_db();
        src.save_host(&sample_host("from-backup")).expect("save");
        let snapshot = src.export_db_snapshot().expect("export");

        // Destination already has unrelated data; import must replace it.
        let (dst, _d2) = test_db();
        dst.save_host(&sample_host("pre-existing")).expect("save");
        dst.import_db_snapshot(&snapshot).expect("import");

        let ids: Vec<String> = dst
            .list_hosts()
            .unwrap()
            .into_iter()
            .map(|h| h.id)
            .collect();
        assert_eq!(ids, vec!["from-backup".to_string()]);
    }

    #[test]
    fn db_snapshot_import_rejects_non_backup() {
        let (dst, _d) = test_db();
        let err = dst
            .import_db_snapshot(b"this is not a sqlite database")
            .expect_err("must reject");
        // Either a validation message or a sqlite "not a database" error; both
        // mean the import refused garbage rather than corrupting the live DB.
        assert!(matches!(err, DbError::Validation(_) | DbError::Sqlite(_)));
        // Live DB is untouched / usable.
        assert!(dst.list_hosts().expect("list").is_empty());
    }

    #[test]
    fn upsert_updates_fields() {
        let (db, _dir) = test_db();
        let h = sample_host("host-2");
        db.save_host(&h).expect("initial save");

        let updated = SavedHost {
            label: "Renamed".to_string(),
            updated_at: "2026-06-01T00:00:00".to_string(),
            ..h
        };
        db.save_host(&updated).expect("upsert");

        let fetched = db.get_host("host-2").expect("get").expect("Some");
        assert_eq!(fetched.label, "Renamed");
    }

    /// Helper: build a host that tunnels through `jump_id`.
    fn host_with_jump(id: &str, jump_id: &str) -> SavedHost {
        SavedHost {
            proxy_jump_host_id: Some(jump_id.to_string()),
            ..sample_host(id)
        }
    }

    #[test]
    fn proxy_jump_host_id_round_trips() {
        let (db, _dir) = test_db();

        // Jump host first, then the target that tunnels through it.
        db.save_host(&sample_host("jump-1")).expect("save jump");
        db.save_host_validated(&host_with_jump("target-1", "jump-1"))
            .expect("save target");

        let fetched = db.get_host("target-1").expect("get").expect("Some");
        assert_eq!(fetched.proxy_jump_host_id.as_deref(), Some("jump-1"));

        // list_hosts must surface the column too.
        let listed = db.list_hosts().expect("list");
        let t = listed.iter().find(|h| h.id == "target-1").expect("present");
        assert_eq!(t.proxy_jump_host_id.as_deref(), Some("jump-1"));

        // Re-point the target at a different jump host: exercises the UPSERT
        // `DO UPDATE SET proxy_jump_host_id` branch the UI save path uses.
        db.save_host(&sample_host("jump-2")).expect("save jump-2");
        db.save_host_validated(&host_with_jump("target-1", "jump-2"))
            .expect("re-point");
        let repointed = db.get_host("target-1").expect("get").expect("Some");
        assert_eq!(repointed.proxy_jump_host_id.as_deref(), Some("jump-2"));

        // Clearing it via the real upsert path (proxy_jump_host_id: None) works.
        db.save_host_validated(&sample_host("target-1"))
            .expect("clear");
        let cleared = db.get_host("target-1").expect("get").expect("Some");
        assert!(cleared.proxy_jump_host_id.is_none());
    }

    #[test]
    fn start_directory_round_trips() {
        let (db, _dir) = test_db();

        let mut host = sample_host("sd-1");
        host.start_directory = Some("/var/www".to_string());
        db.save_host(&host).expect("save");

        // get_host and list_hosts must both surface the column.
        let fetched = db.get_host("sd-1").expect("get").expect("Some");
        assert_eq!(fetched.start_directory.as_deref(), Some("/var/www"));
        let listed = db.list_hosts().expect("list");
        let h = listed.iter().find(|h| h.id == "sd-1").expect("present");
        assert_eq!(h.start_directory.as_deref(), Some("/var/www"));

        // Clearing it via the upsert path works.
        db.save_host(&sample_host("sd-1")).expect("clear");
        let cleared = db.get_host("sd-1").expect("get").expect("Some");
        assert!(cleared.start_directory.is_none());
    }

    #[test]
    fn save_rejects_self_referential_proxy_jump() {
        let (db, _dir) = test_db();
        db.save_host(&sample_host("a")).expect("save a");
        let err = db
            .save_host_validated(&host_with_jump("a", "a"))
            .expect_err("self-reference must be rejected");
        assert!(matches!(err, DbError::Validation(_)), "got {err:?}");
    }

    #[test]
    fn save_rejects_two_hop_cycle() {
        let (db, _dir) = test_db();
        // a (no jump), b → a.
        db.save_host(&sample_host("a")).expect("save a");
        db.save_host_validated(&host_with_jump("b", "a"))
            .expect("save b→a");
        // Now a → b would close the loop a → b → a.
        let err = db
            .save_host_validated(&host_with_jump("a", "b"))
            .expect_err("cycle must be rejected");
        assert!(matches!(err, DbError::Validation(_)), "got {err:?}");
    }

    #[test]
    fn save_accepts_valid_linear_chain() {
        let (db, _dir) = test_db();
        db.save_host(&sample_host("a")).expect("save a");
        db.save_host_validated(&host_with_jump("b", "a"))
            .expect("b→a");
        db.save_host_validated(&host_with_jump("c", "b"))
            .expect("c→b (linear chain a←b←c is valid)");
        let c = db.get_host("c").expect("get").expect("Some");
        assert_eq!(c.proxy_jump_host_id.as_deref(), Some("b"));
    }

    #[test]
    fn save_rejects_dangling_jump_target() {
        let (db, _dir) = test_db();
        // No host "ghost" exists; the FK would reject this, but we want a friendly
        // Validation error rather than a raw sqlite constraint failure.
        let err = db
            .save_host_validated(&host_with_jump("a", "ghost"))
            .expect_err("dangling target must be rejected");
        assert!(matches!(err, DbError::Validation(_)), "got {err:?}");
    }

    #[test]
    fn deleting_jump_host_nulls_dependent() {
        let (db, _dir) = test_db();
        db.save_host(&sample_host("jump")).expect("save jump");
        db.save_host_validated(&host_with_jump("target", "jump"))
            .expect("save target→jump");

        // ON DELETE SET NULL (with foreign_keys=ON) must clear the dependent link.
        db.delete_host("jump").expect("delete jump");
        let target = db.get_host("target").expect("get").expect("Some");
        assert!(
            target.proxy_jump_host_id.is_none(),
            "deleting the jump host should NULL the dependent proxy_jump_host_id",
        );
    }

    #[test]
    fn validated_setter_rejects_cycle() {
        let (db, _dir) = test_db();
        db.save_host(&sample_host("a")).expect("save a");
        db.save_host(&sample_host("b")).expect("save b");
        db.set_proxy_jump_host_validated("a", "b").expect("a→b");
        // b → a would form a cycle; the import path must reject it.
        let err = db
            .set_proxy_jump_host_validated("b", "a")
            .expect_err("cycle via setter must be rejected");
        assert!(matches!(err, DbError::Validation(_)), "got {err:?}");
        // Self-reference too.
        let err = db
            .set_proxy_jump_host_validated("a", "a")
            .expect_err("self-reference via setter must be rejected");
        assert!(matches!(err, DbError::Validation(_)), "got {err:?}");
    }

    #[test]
    fn migrations_are_idempotent_across_reopen() {
        let dir = std::env::temp_dir().join(format!("anyscp_test_{}", uuid::Uuid::new_v4()));
        {
            let db = HostDb::new(&dir).expect("first open");
            db.save_host(&sample_host("persisted")).expect("save");
        }
        // Re-opening the same directory re-runs migrations against an already
        // up-to-date schema; it must not error and must preserve data.
        let db2 = HostDb::new(&dir).expect("second open re-runs migrations cleanly");
        let h = db2.get_host("persisted").expect("get").expect("Some");
        assert_eq!(h.id, "persisted");
    }

    #[test]
    fn delete_removes_row() {
        let (db, _dir) = test_db();
        db.save_host(&sample_host("host-3")).expect("save");
        db.delete_host("host-3").expect("delete");
        assert!(db.get_host("host-3").expect("get").is_none());
    }

    #[test]
    fn delete_missing_returns_not_found() {
        let (db, _dir) = test_db();
        let err = db.delete_host("nonexistent").expect_err("should fail");
        assert!(matches!(err, DbError::NotFound(_)));
    }

    #[test]
    fn get_missing_returns_none() {
        let (db, _dir) = test_db();
        let result = db.get_host("ghost").expect("no error");
        assert!(result.is_none());
    }

    #[test]
    fn round_trip_create_and_list_groups() {
        let (db, _dir) = test_db();
        let g = sample_group("group-1");
        db.create_group(&g).expect("create_group");

        let all = db.list_groups().expect("list_groups");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "group-1");
        assert_eq!(all[0].color, "#6366f1");
        assert!(all[0].default_username.is_none());
    }

    #[test]
    fn update_group_changes_fields() {
        let (db, _dir) = test_db();
        let g = sample_group("group-2");
        db.create_group(&g).expect("create_group");

        let updated = HostGroup {
            name: "Renamed Group".to_string(),
            color: "#ec4899".to_string(),
            updated_at: "2026-06-01T00:00:00".to_string(),
            ..g
        };
        db.update_group(&updated).expect("update_group");

        let all = db.list_groups().expect("list_groups");
        assert_eq!(all[0].name, "Renamed Group");
        assert_eq!(all[0].color, "#ec4899");
    }

    #[test]
    fn delete_group_orphans_hosts() {
        let (db, _dir) = test_db();

        // Create a group and assign a host to it.
        let g = sample_group("group-3");
        db.create_group(&g).expect("create_group");

        let h = SavedHost {
            group_id: Some("group-3".to_string()),
            ..sample_host("host-orphan")
        };
        db.save_host(&h).expect("save_host");

        // Verify the assignment was persisted.
        let before = db.get_host("host-orphan").expect("get").expect("Some");
        assert_eq!(before.group_id.as_deref(), Some("group-3"));

        // Deleting the group must set the host's group_id to NULL.
        db.delete_group("group-3").expect("delete_group");

        let after = db.get_host("host-orphan").expect("get").expect("Some");
        assert!(
            after.group_id.is_none(),
            "host should be orphaned after group deletion"
        );
    }

    #[test]
    fn delete_missing_group_returns_not_found() {
        let (db, _dir) = test_db();
        let err = db.delete_group("ghost-group").expect_err("should fail");
        assert!(matches!(err, DbError::NotFound(_)));
    }

    // -----------------------------------------------------------------------
    // Connection history tests
    // -----------------------------------------------------------------------

    #[test]
    fn record_and_list_recent_connections() {
        let (db, _dir) = test_db();
        let h = sample_host("conn-host-1");
        db.save_host(&h).expect("save_host");

        db.record_connection("conn-host-1")
            .expect("record_connection");

        let recent = db.list_recent_connections(10).expect("list_recent");
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].host_id, "conn-host-1");
        assert_eq!(recent[0].host_label, "My Server conn-host-1");
        assert_eq!(recent[0].host, "192.0.2.1");
        assert_eq!(recent[0].port, 22);
        assert_eq!(recent[0].username, "alice");
        assert!(!recent[0].connected_at.is_empty());
    }

    #[test]
    fn list_recent_connections_deduplicates_by_host() {
        let (db, _dir) = test_db();
        let h = sample_host("dedup-host");
        db.save_host(&h).expect("save_host");

        // Record the same host three times.
        db.record_connection("dedup-host").expect("first");
        db.record_connection("dedup-host").expect("second");
        db.record_connection("dedup-host").expect("third");

        // The host must appear only once, with the latest connected_at.
        let recent = db.list_recent_connections(10).expect("list_recent");
        assert_eq!(
            recent.iter().filter(|r| r.host_id == "dedup-host").count(),
            1
        );
    }

    #[test]
    fn list_recent_connections_respects_limit() {
        let (db, _dir) = test_db();

        for i in 0..5 {
            let h = sample_host(&format!("limit-host-{i}"));
            db.save_host(&h).expect("save_host");
            db.record_connection(&format!("limit-host-{i}"))
                .expect("record");
        }

        let recent = db.list_recent_connections(3).expect("list_recent");
        assert_eq!(recent.len(), 3);
    }

    #[test]
    fn record_connection_prunes_to_500_rows() {
        let (db, _dir) = test_db();

        // Create one host and record 510 connections for it so pruning kicks in.
        let h = sample_host("prune-host");
        db.save_host(&h).expect("save_host");

        for _ in 0..510 {
            db.record_connection("prune-host").expect("record");
        }

        // Directly count rows in the table via a query to confirm pruning.
        let conn = db.conn.lock().expect("lock");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM connection_history", [], |r| r.get(0))
            .expect("count");
        assert!(
            count <= 500,
            "expected at most 500 rows after pruning, got {count}"
        );
    }

    #[test]
    fn delete_host_cascades_to_history() {
        let (db, _dir) = test_db();
        let h = sample_host("cascade-host");
        db.save_host(&h).expect("save_host");
        db.record_connection("cascade-host").expect("record");

        // Confirm the history row exists.
        let recent = db.list_recent_connections(10).expect("list_recent");
        assert_eq!(recent.len(), 1);

        // Deleting the host must cascade-delete its history rows.
        db.delete_host("cascade-host").expect("delete_host");

        let conn = db.conn.lock().expect("lock");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM connection_history", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 0, "history should be empty after host deletion");
    }

    // -----------------------------------------------------------------------
    // Snippet helpers
    // -----------------------------------------------------------------------

    fn sample_snippet(id: &str) -> Snippet {
        Snippet {
            id: id.to_string(),
            name: format!("Snippet {id}"),
            command: format!("echo {id}"),
            description: Some(format!("A test snippet for {id}")),
            folder_id: None,
            tags: Some("test shell".to_string()),
            variables: None,
            is_dangerous: false,
            use_count: 0,
            last_used_at: None,
            sort_order: 0,
            created_at: "2026-01-01T00:00:00".to_string(),
            updated_at: "2026-01-01T00:00:00".to_string(),
        }
    }

    fn sample_snippet_folder(id: &str) -> SnippetFolder {
        SnippetFolder {
            id: id.to_string(),
            name: format!("Folder {id}"),
            parent_id: None,
            color: Some("#6366f1".to_string()),
            icon: None,
            sort_order: 0,
            created_at: "2026-01-01T00:00:00".to_string(),
            updated_at: "2026-01-01T00:00:00".to_string(),
        }
    }

    // -----------------------------------------------------------------------
    // Snippet tests
    // -----------------------------------------------------------------------

    #[test]
    fn round_trip_save_and_list_snippets() {
        let (db, _dir) = test_db();
        let s = sample_snippet("snip-1");
        db.save_snippet(&s).expect("save_snippet");

        let all = db.list_snippets(None).expect("list_snippets");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, "snip-1");
        assert_eq!(all[0].command, "echo snip-1");
        assert!(!all[0].is_dangerous);
        assert_eq!(all[0].use_count, 0);
    }

    #[test]
    fn upsert_snippet_updates_fields() {
        let (db, _dir) = test_db();
        let s = sample_snippet("snip-2");
        db.save_snippet(&s).expect("initial save");

        let updated = Snippet {
            name: "Renamed Snippet".to_string(),
            command: "echo updated".to_string(),
            is_dangerous: true,
            updated_at: "2026-06-01T00:00:00".to_string(),
            ..s
        };
        db.save_snippet(&updated).expect("upsert");

        let fetched = db.get_snippet("snip-2").expect("get").expect("Some");
        assert_eq!(fetched.name, "Renamed Snippet");
        assert_eq!(fetched.command, "echo updated");
        assert!(fetched.is_dangerous);
        // created_at must not be overwritten by the upsert
        assert_eq!(fetched.created_at, "2026-01-01T00:00:00");
    }

    #[test]
    fn delete_snippet_removes_row() {
        let (db, _dir) = test_db();
        db.save_snippet(&sample_snippet("snip-3")).expect("save");
        db.delete_snippet("snip-3").expect("delete");
        assert!(db.get_snippet("snip-3").expect("get").is_none());
    }

    #[test]
    fn list_snippets_filters_by_folder() {
        let (db, _dir) = test_db();

        // Create a folder and two snippets — one inside, one outside.
        let folder = sample_snippet_folder("folder-a");
        db.save_snippet_folder(&folder).expect("save folder");

        let inside = Snippet {
            folder_id: Some("folder-a".to_string()),
            ..sample_snippet("snip-in")
        };
        let outside = sample_snippet("snip-out");

        db.save_snippet(&inside).expect("save inside");
        db.save_snippet(&outside).expect("save outside");

        let filtered = db.list_snippets(Some("folder-a")).expect("list filtered");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, "snip-in");

        let all = db.list_snippets(None).expect("list all");
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn record_snippet_use_increments_count() {
        let (db, _dir) = test_db();
        db.save_snippet(&sample_snippet("snip-use")).expect("save");

        db.record_snippet_use("snip-use").expect("use 1");
        db.record_snippet_use("snip-use").expect("use 2");
        db.record_snippet_use("snip-use").expect("use 3");

        let s = db.get_snippet("snip-use").expect("get").expect("Some");
        assert_eq!(s.use_count, 3);
        assert!(s.last_used_at.is_some(), "last_used_at should be set");
    }

    #[test]
    fn fts5_search_by_name() {
        let (db, _dir) = test_db();
        let s = Snippet {
            name: "Deploy to production".to_string(),
            command: "kubectl apply -f prod.yaml".to_string(),
            tags: None,
            description: None,
            ..sample_snippet("snip-fts-name")
        };
        db.save_snippet(&s).expect("save");

        let results = db.search_snippets("Deploy", 10).expect("search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].snippet.id, "snip-fts-name");
    }

    #[test]
    fn fts5_search_by_tag() {
        let (db, _dir) = test_db();
        let s = Snippet {
            name: "List pods".to_string(),
            command: "kubectl get pods".to_string(),
            tags: Some("kubernetes k8s ops".to_string()),
            description: None,
            ..sample_snippet("snip-fts-tag")
        };
        db.save_snippet(&s).expect("save");

        let results = db.search_snippets("kubernetes", 10).expect("search by tag");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].snippet.id, "snip-fts-tag");
    }

    #[test]
    fn fts5_search_no_results() {
        let (db, _dir) = test_db();
        db.save_snippet(&sample_snippet("snip-nomatch"))
            .expect("save");

        let results = db
            .search_snippets("zzz_definitely_not_present", 10)
            .expect("search");
        assert!(results.is_empty());
    }

    #[test]
    fn folder_delete_orphans_snippets() {
        let (db, _dir) = test_db();

        let folder = sample_snippet_folder("folder-del");
        db.save_snippet_folder(&folder).expect("save folder");

        let s = Snippet {
            folder_id: Some("folder-del".to_string()),
            ..sample_snippet("snip-orphan")
        };
        db.save_snippet(&s).expect("save snippet");

        // Confirm the folder_id is set.
        let before = db.get_snippet("snip-orphan").expect("get").expect("Some");
        assert_eq!(before.folder_id.as_deref(), Some("folder-del"));

        // Deleting the folder must NULL out the snippet's folder_id.
        db.delete_snippet_folder("folder-del")
            .expect("delete folder");

        let after = db.get_snippet("snip-orphan").expect("get").expect("Some");
        assert!(
            after.folder_id.is_none(),
            "snippet should be orphaned after folder deletion"
        );
    }
}
