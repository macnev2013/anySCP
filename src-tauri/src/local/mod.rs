//! Local filesystem browsing for the dual-pane explorer.
//!
//! Local-machine counterparts to the remote `sftp_*` listing/CRUD commands.
//! Stateless (no session, no manager); returns `SftpEntry`-shaped rows so the
//! shared explorer table renders them unchanged. Split so `mod.rs` stays thin:
//! `types` (wire types), `platform` (OS-specific bits), `fs` (operations +
//! tests), `commands` (Tauri wrappers).

pub mod commands;
mod fs;
mod platform;
mod types;

pub use fs::{
    copy_entries, create_file, delete, edit, home_dir, list_dir, mkdir, move_entries, rename,
};
pub use platform::roots;
pub use types::{LocalEntry, LocalError};
