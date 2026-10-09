//! Platform-specific local-filesystem bits, isolated so the rest of the module
//! is OS-agnostic. macOS and Linux share the `unix` path; Windows takes the
//! `not(unix)` / `windows` path.

/// The lower 12 bits of a file's Unix mode (permission + setuid/setgid/sticky).
/// Windows has no Unix mode, so it reports 0 (rendered as a blank permissions
/// column).
#[cfg(unix)]
pub fn mode_of(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o7777
}

#[cfg(not(unix))]
pub fn mode_of(_meta: &std::fs::Metadata) -> u32 {
    0
}

/// Filesystem roots for the path bar: `/` on Unix; the mounted drive letters on
/// Windows. Windows has no std API for this, so we probe `A:\`..`Z:\` — cheap
/// (a handful of stat calls) and dependency-free.
#[must_use]
#[cfg(windows)]
pub fn roots() -> Vec<String> {
    ('A'..='Z')
        .map(|c| format!("{c}:\\"))
        .filter(|p| std::path::Path::new(p).exists())
        .collect()
}

#[must_use]
#[cfg(not(windows))]
pub fn roots() -> Vec<String> {
    vec!["/".to_string()]
}
