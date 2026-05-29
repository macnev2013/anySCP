//! Portable directory-listing and stat parsing for SCP mode.
//!
//! SCP has no native filesystem ops, so we shell out over SSH. The exact
//! command differs by the remote's userland:
//!
//! - **GNU** (Ubuntu, Debian, Fedora, RHEL, Arch, Alpine+coreutils, …):
//!   `find … -printf` emits everything in one machine-readable, NUL-delimited
//!   pass. Fastest and most robust.
//! - **busybox** (minimal Alpine, routers, IoT): busybox `find` has no
//!   `-printf`, but busybox `stat -c` works — so we `find … -exec stat -c …`.
//! - **BSD / macOS**: neither `find -printf` nor `stat -c`; BSD `stat -f` uses
//!   a different format language, so we `find … -exec stat -f …`.
//!
//! The flavor is detected once per session (see [`Flavor`] /
//! `exec::detect_flavor`). This module holds the **pure parsers** — they take
//! raw command bytes and produce [`ScpEntry`] / [`StatInfo`] / [`TreeEntry`],
//! with no SSH dependency, so every flavor is unit-tested below.

use super::{format_permissions, ScpEntry, ScpEntryType, ScpError};

/// Which remote userland we're talking to. Detected once at session open.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    /// GNU coreutils + findutils (`find -printf`, `stat -c`).
    Gnu,
    /// busybox (`stat -c` works, `find -printf` does not).
    Busybox,
    /// BSD / macOS (`stat -f`, no `find -printf`, no `stat -c`).
    Bsd,
}

impl Default for Flavor {
    /// GNU is the safest assumption when detection is inconclusive — it's the
    /// most common server userland and its commands are the most capable.
    fn default() -> Self {
        Flavor::Gnu
    }
}

impl Flavor {
    pub fn as_str(self) -> &'static str {
        match self {
            Flavor::Gnu => "gnu",
            Flavor::Busybox => "busybox",
            Flavor::Bsd => "bsd",
        }
    }

    pub fn parse(s: &str) -> Option<Flavor> {
        match s.trim() {
            "gnu" => Some(Flavor::Gnu),
            "busybox" => Some(Flavor::Busybox),
            "bsd" => Some(Flavor::Bsd),
            _ => None,
        }
    }
}

/// Result of stat-ing a single path.
#[derive(Debug, Clone)]
pub struct StatInfo {
    pub entry_type: ScpEntryType,
    #[allow(dead_code)]
    pub mode: u32,
    pub size: u64,
    #[allow(dead_code)]
    pub mtime: u64,
}

/// One node in a recursive walk, path relative to the walk root.
#[derive(Debug, Clone)]
pub struct TreeEntry {
    pub rel_path: String,
    pub is_dir: bool,
    pub size: u64,
}

// ─── Command builders ────────────────────────────────────────────────────────
// Format strings each flavor's listing/stat commands use. Kept next to the
// parsers so the producer and consumer stay in sync.

// NOTE on escapes: `find -printf` interprets backslash escapes (`\t`, `\0`),
// so its formats use *literal* backslash-t / backslash-0 (raw strings).
// `stat -c` / `stat -f` do NOT interpret escapes — they emit the format
// bytes verbatim — so their formats embed *real* tab characters ("\t" in a
// non-raw string literal is a 0x09 byte). Both end up tab-separated on the
// wire, which is what the parsers split on.

/// `find` `-printf` format for GNU one-pass listing (NUL-delimited records).
pub const GNU_LISTING_PRINTF: &str = r"%y\t%m\t%s\t%T@\t%f\0";
/// GNU `find` `-printf` for a recursive tree walk (relative paths).
pub const GNU_TREE_PRINTF: &str = r"%y\t%s\t%P\0";
/// `stat -c` format (GNU + busybox), single stat. Fields: human-type,
/// octal-perms, size, mtime-epoch. Real tabs (stat -c doesn't interpret \t).
pub const STATC_FMT: &str = "%F\t%a\t%s\t%Y";
/// `stat -c` with the file name appended, for `-exec` listing.
pub const STATC_FMT_NAMED: &str = "%F\t%a\t%s\t%Y\t%n";
/// `stat -c` for a tree walk: type, size, name.
pub const STATC_TREE_FMT: &str = "%F\t%s\t%n";
/// `stat -f` format (BSD/macOS), single stat. Fields: perm-string, size, mtime.
pub const STATF_FMT: &str = "%Sp\t%z\t%m";
/// `stat -f` with name, for `-exec` listing.
pub const STATF_FMT_NAMED: &str = "%Sp\t%z\t%m\t%N";
/// `stat -f` for a tree walk: perm-string, size, name.
pub const STATF_TREE_FMT: &str = "%Sp\t%z\t%N";

// ─── Helpers ───────────────────────────────────────────────────────────────────

fn basename(path: &str) -> &str {
    match path.rfind('/') {
        Some(i) => &path[i + 1..],
        None => path,
    }
}

fn join_remote(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

fn type_from_y(c: &str) -> (ScpEntryType, bool) {
    match c {
        "f" => (ScpEntryType::File, false),
        "d" => (ScpEntryType::Directory, false),
        "l" => (ScpEntryType::Symlink, true),
        _ => (ScpEntryType::Other, false),
    }
}

fn type_from_human(f: &str) -> (ScpEntryType, bool) {
    match f {
        "regular file" | "regular empty file" => (ScpEntryType::File, false),
        "directory" => (ScpEntryType::Directory, false),
        "symbolic link" => (ScpEntryType::Symlink, true),
        _ => (ScpEntryType::Other, false),
    }
}

/// Map a BSD `%Sp` permission string (e.g. `drwxr-xr-x`) to type + mode bits.
/// The leading char is the type; the next 9 are the rwx triads.
fn parse_sp(sp: &str) -> (ScpEntryType, bool, u32) {
    let chars: Vec<char> = sp.chars().collect();
    let (entry_type, is_symlink) = match chars.first() {
        Some('d') => (ScpEntryType::Directory, false),
        Some('l') => (ScpEntryType::Symlink, true),
        Some('-') => (ScpEntryType::File, false),
        _ => (ScpEntryType::Other, false),
    };
    let mode = if chars.len() >= 10 {
        rwx_to_mode(&sp[sp.char_indices().nth(1).map(|(i, _)| i).unwrap_or(1)..])
    } else {
        0
    };
    (entry_type, is_symlink, mode)
}

/// Convert a 9-char `rwxrwxrwx`-style string (with optional s/S/t/T) to a
/// 12-bit Unix mode (including setuid/setgid/sticky).
fn rwx_to_mode(rwx: &str) -> u32 {
    let b: Vec<char> = rwx.chars().take(9).collect();
    if b.len() < 9 {
        return 0;
    }
    let mut mode: u32 = 0;
    // Read triads: owner, group, other.
    if b[0] == 'r' {
        mode |= 0o400;
    }
    if b[1] == 'w' {
        mode |= 0o200;
    }
    match b[2] {
        'x' => mode |= 0o100,
        's' => mode |= 0o100 | 0o4000,
        'S' => mode |= 0o4000,
        _ => {}
    }
    if b[3] == 'r' {
        mode |= 0o040;
    }
    if b[4] == 'w' {
        mode |= 0o020;
    }
    match b[5] {
        'x' => mode |= 0o010,
        's' => mode |= 0o010 | 0o2000,
        'S' => mode |= 0o2000,
        _ => {}
    }
    if b[6] == 'r' {
        mode |= 0o004;
    }
    if b[7] == 'w' {
        mode |= 0o002;
    }
    match b[8] {
        'x' => mode |= 0o001,
        't' => mode |= 0o001 | 0o1000,
        'T' => mode |= 0o1000,
        _ => {}
    }
    mode
}

fn mk_entry(
    name: &str,
    path: String,
    entry_type: ScpEntryType,
    is_symlink: bool,
    permissions: u32,
    size: u64,
    modified: Option<u64>,
) -> ScpEntry {
    let permissions = permissions & 0o7777;
    ScpEntry {
        name: name.to_string(),
        path,
        entry_type,
        size,
        permissions,
        permissions_display: format_permissions(permissions),
        modified,
        is_symlink,
    }
}

/// Directories first, then case-insensitive alphabetical within each group.
pub fn sort_entries(entries: &mut [ScpEntry]) {
    entries.sort_by(|a, b| {
        let a_dir = a.entry_type == ScpEntryType::Directory;
        let b_dir = b.entry_type == ScpEntryType::Directory;
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

// ─── Listing parsers ─────────────────────────────────────────────────────────

/// Parse GNU `find -printf '%y\t%m\t%s\t%T@\t%f\0'` output.
pub fn parse_gnu_listing(stdout: &[u8], dir: &str) -> Result<Vec<ScpEntry>, ScpError> {
    let mut out = Vec::new();
    for record in stdout.split(|b| *b == 0) {
        if record.is_empty() {
            continue;
        }
        let line = std::str::from_utf8(record)
            .map_err(|e| ScpError::ParseError(format!("non-UTF-8 listing record: {e}")))?;
        let parts: Vec<&str> = line.splitn(5, '\t').collect();
        if parts.len() != 5 {
            return Err(ScpError::ParseError(format!(
                "GNU listing record has {} fields, expected 5: {line:?}",
                parts.len()
            )));
        }
        let (entry_type, is_symlink) = type_from_y(parts[0]);
        let permissions = u32::from_str_radix(parts[1], 8).unwrap_or(0);
        let size: u64 = parts[2].parse().unwrap_or(0);
        let modified: Option<u64> = parts[3].split('.').next().and_then(|s| s.parse().ok());
        let name = parts[4];
        out.push(mk_entry(
            name,
            join_remote(dir, name),
            entry_type,
            is_symlink,
            permissions,
            size,
            modified,
        ));
    }
    sort_entries(&mut out);
    Ok(out)
}

/// Parse `find … -exec stat -c '%F\t%a\t%s\t%Y\t%n' {} +` output (GNU/busybox),
/// one newline-delimited record per entry, `%n` = full path.
pub fn parse_statc_listing(stdout: &[u8], _dir: &str) -> Result<Vec<ScpEntry>, ScpError> {
    let text = std::str::from_utf8(stdout)
        .map_err(|e| ScpError::ParseError(format!("non-UTF-8 stat output: {e}")))?;
    let mut out = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(5, '\t').collect();
        if parts.len() != 5 {
            return Err(ScpError::ParseError(format!(
                "stat -c record has {} fields, expected 5: {line:?}",
                parts.len()
            )));
        }
        let (entry_type, is_symlink) = type_from_human(parts[0]);
        let permissions = u32::from_str_radix(parts[1], 8).unwrap_or(0);
        let size: u64 = parts[2].parse().unwrap_or(0);
        let modified: Option<u64> = parts[3].parse().ok();
        let full = parts[4];
        out.push(mk_entry(
            basename(full),
            full.to_string(),
            entry_type,
            is_symlink,
            permissions,
            size,
            modified,
        ));
    }
    sort_entries(&mut out);
    Ok(out)
}

/// Parse `find … -exec stat -f '%Sp\t%z\t%m\t%N' {} +` output (BSD/macOS).
pub fn parse_statf_listing(stdout: &[u8], _dir: &str) -> Result<Vec<ScpEntry>, ScpError> {
    let text = std::str::from_utf8(stdout)
        .map_err(|e| ScpError::ParseError(format!("non-UTF-8 stat output: {e}")))?;
    let mut out = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(4, '\t').collect();
        if parts.len() != 4 {
            return Err(ScpError::ParseError(format!(
                "stat -f record has {} fields, expected 4: {line:?}",
                parts.len()
            )));
        }
        let (entry_type, is_symlink, permissions) = parse_sp(parts[0]);
        let size: u64 = parts[1].parse().unwrap_or(0);
        let modified: Option<u64> = parts[2].parse().ok();
        let full = parts[3];
        out.push(mk_entry(
            basename(full),
            full.to_string(),
            entry_type,
            is_symlink,
            permissions,
            size,
            modified,
        ));
    }
    sort_entries(&mut out);
    Ok(out)
}

// ─── Single-stat parsers ───────────────────────────────────────────────────────

/// Parse `stat -c '%F\t%a\t%s\t%Y'` output (single path; GNU/busybox).
pub fn parse_statc_single(stdout: &[u8]) -> Result<Option<StatInfo>, ScpError> {
    let text = std::str::from_utf8(stdout)
        .map_err(|e| ScpError::ParseError(format!("non-UTF-8 stat output: {e}")))?;
    let line = text.trim_end_matches('\n');
    if line.is_empty() {
        return Ok(None);
    }
    let parts: Vec<&str> = line.split('\t').collect();
    if parts.len() != 4 {
        return Err(ScpError::ParseError(format!(
            "stat -c expected 4 fields, got {} in {line:?}",
            parts.len()
        )));
    }
    let (entry_type, _) = type_from_human(parts[0]);
    let mode = u32::from_str_radix(parts[1], 8)
        .map_err(|e| ScpError::ParseError(format!("stat -c bad mode {:?}: {e}", parts[1])))?;
    let size: u64 = parts[2]
        .parse()
        .map_err(|e| ScpError::ParseError(format!("stat -c bad size {:?}: {e}", parts[2])))?;
    let mtime: u64 = parts[3]
        .parse()
        .map_err(|e| ScpError::ParseError(format!("stat -c bad mtime {:?}: {e}", parts[3])))?;
    Ok(Some(StatInfo {
        entry_type,
        mode,
        size,
        mtime,
    }))
}

/// Parse `stat -f '%Sp\t%z\t%m'` output (single path; BSD/macOS).
pub fn parse_statf_single(stdout: &[u8]) -> Result<Option<StatInfo>, ScpError> {
    let text = std::str::from_utf8(stdout)
        .map_err(|e| ScpError::ParseError(format!("non-UTF-8 stat output: {e}")))?;
    let line = text.trim_end_matches('\n');
    if line.is_empty() {
        return Ok(None);
    }
    let parts: Vec<&str> = line.split('\t').collect();
    if parts.len() != 3 {
        return Err(ScpError::ParseError(format!(
            "stat -f expected 3 fields, got {} in {line:?}",
            parts.len()
        )));
    }
    let (entry_type, _, mode) = parse_sp(parts[0]);
    let size: u64 = parts[1]
        .parse()
        .map_err(|e| ScpError::ParseError(format!("stat -f bad size {:?}: {e}", parts[1])))?;
    let mtime: u64 = parts[2]
        .parse()
        .map_err(|e| ScpError::ParseError(format!("stat -f bad mtime {:?}: {e}", parts[2])))?;
    Ok(Some(StatInfo {
        entry_type,
        mode,
        size,
        mtime,
    }))
}

// ─── Tree parsers ──────────────────────────────────────────────────────────────

/// Parse GNU `find -mindepth 1 -printf '%y\t%s\t%P\0'` (relative paths).
pub fn parse_gnu_tree(stdout: &[u8]) -> Result<Vec<TreeEntry>, ScpError> {
    let mut out = Vec::new();
    for record in stdout.split(|b| *b == 0) {
        if record.is_empty() {
            continue;
        }
        let line = std::str::from_utf8(record)
            .map_err(|e| ScpError::ParseError(format!("non-UTF-8 tree record: {e}")))?;
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() != 3 {
            return Err(ScpError::ParseError(format!(
                "GNU tree record has {} fields, expected 3: {line:?}",
                parts.len()
            )));
        }
        let is_dir = parts[0] == "d";
        let size: u64 = parts[1].parse().unwrap_or(0);
        let rel_path = parts[2].to_string();
        if rel_path.is_empty() {
            continue;
        }
        out.push(TreeEntry {
            rel_path,
            is_dir,
            size,
        });
    }
    Ok(out)
}

/// Parse busybox/GNU `find DIR … -exec stat -c '%F\t%s\t%n' {} +` into a tree,
/// deriving each rel path by stripping the `DIR/` prefix from `%n`.
pub fn parse_statc_tree(stdout: &[u8], dir: &str) -> Result<Vec<TreeEntry>, ScpError> {
    // Field 0 is the human type ("directory"), 1 = size, 2 = full path.
    parse_exec_tree(stdout, dir, |type_field| type_field == "directory")
}

/// Parse BSD `find DIR … -exec stat -f '%Sp\t%z\t%N' {} +` into a tree.
pub fn parse_statf_tree(stdout: &[u8], dir: &str) -> Result<Vec<TreeEntry>, ScpError> {
    // Field 0 is the perm string ("drwx…"); leading 'd' means directory.
    parse_exec_tree(stdout, dir, |type_field| type_field.starts_with('d'))
}

/// Shared `-exec stat` tree parser. Records are newline-delimited with three
/// tab fields: `<type>\t<size>\t<full_path>`. `is_dir` decides directoryness
/// from the (flavor-specific) type field.
fn parse_exec_tree(
    stdout: &[u8],
    dir: &str,
    is_dir: impl Fn(&str) -> bool,
) -> Result<Vec<TreeEntry>, ScpError> {
    let text = std::str::from_utf8(stdout)
        .map_err(|e| ScpError::ParseError(format!("non-UTF-8 tree output: {e}")))?;
    let prefix = format!("{}/", dir.trim_end_matches('/'));
    let mut out = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        let fields: Vec<&str> = line.splitn(3, '\t').collect();
        if fields.len() != 3 {
            return Err(ScpError::ParseError(format!(
                "tree record has {} fields, expected 3: {line:?}",
                fields.len()
            )));
        }
        let dir_flag = is_dir(fields[0]);
        let size: u64 = fields[1].parse().unwrap_or(0);
        let full = fields[2];
        let rel_path = full.strip_prefix(&prefix).unwrap_or(full);
        if rel_path.is_empty() {
            continue;
        }
        out.push(TreeEntry {
            rel_path: rel_path.to_string(),
            is_dir: dir_flag,
            size,
        });
    }
    Ok(out)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flavor_round_trip() {
        for f in [Flavor::Gnu, Flavor::Busybox, Flavor::Bsd] {
            assert_eq!(Flavor::parse(f.as_str()), Some(f));
        }
        assert_eq!(Flavor::parse("nonsense"), None);
    }

    #[test]
    fn rwx_basic() {
        assert_eq!(rwx_to_mode("rwxr-xr-x"), 0o755);
        assert_eq!(rwx_to_mode("rw-r--r--"), 0o644);
        assert_eq!(rwx_to_mode("---------"), 0);
    }

    #[test]
    fn rwx_special_bits() {
        assert_eq!(rwx_to_mode("rwsr-xr-x"), 0o4755);
        assert_eq!(rwx_to_mode("rwxr-sr-x"), 0o2755);
        assert_eq!(rwx_to_mode("rwxrwxrwt"), 0o1777);
        // Capital S/T = special bit set without the exec bit.
        assert_eq!(rwx_to_mode("rwSr--r--"), 0o4644);
    }

    #[test]
    fn gnu_listing_parses_and_sorts() {
        // NUL-delimited: type, octal mode, size, mtime float, name.
        let raw = b"f\t644\t10\t1700000000.5\tbeta.txt\0d\t755\t40\t1700000001.0\talpha\0l\t777\t5\t1700000002.0\tlink\0";
        let entries = parse_gnu_listing(raw, "/home/u").unwrap();
        // Directory sorts first, then files alphabetically.
        assert_eq!(entries[0].name, "alpha");
        assert_eq!(entries[0].entry_type, ScpEntryType::Directory);
        assert_eq!(entries[0].path, "/home/u/alpha");
        assert_eq!(entries[1].name, "beta.txt");
        assert_eq!(entries[1].size, 10);
        assert_eq!(entries[1].permissions, 0o644);
        assert_eq!(entries[1].modified, Some(1700000000));
        assert_eq!(entries[2].name, "link");
        assert!(entries[2].is_symlink);
    }

    #[test]
    fn gnu_listing_root_dir_paths() {
        let raw = b"d\t755\t40\t1700000001.0\tetc\0";
        let entries = parse_gnu_listing(raw, "/").unwrap();
        assert_eq!(entries[0].path, "/etc");
    }

    #[test]
    fn gnu_listing_name_with_spaces() {
        let raw = b"f\t644\t3\t1700000000.0\tmy file.txt\0";
        let entries = parse_gnu_listing(raw, "/d").unwrap();
        assert_eq!(entries[0].name, "my file.txt");
        assert_eq!(entries[0].path, "/d/my file.txt");
    }

    #[test]
    fn statc_listing_parses() {
        // newline-delimited: human-type, octal, size, mtime, full path.
        let raw = b"regular file\t644\t10\t1700000000\t/home/u/beta.txt\ndirectory\t755\t40\t1700000001\t/home/u/alpha\n";
        let entries = parse_statc_listing(raw, "/home/u").unwrap();
        assert_eq!(entries[0].name, "alpha"); // dir first
        assert_eq!(entries[1].name, "beta.txt");
        assert_eq!(entries[1].path, "/home/u/beta.txt");
        assert_eq!(entries[1].permissions, 0o644);
        assert_eq!(entries[1].modified, Some(1700000000));
    }

    #[test]
    fn statc_listing_empty_file_is_file() {
        let raw = b"regular empty file\t600\t0\t1700000000\t/t/empty\n";
        let entries = parse_statc_listing(raw, "/t").unwrap();
        assert_eq!(entries[0].entry_type, ScpEntryType::File);
    }

    #[test]
    fn statf_listing_parses() {
        // BSD: perm-string, size, mtime, full path.
        let raw = b"-rw-r--r--\t10\t1700000000\t/home/u/beta.txt\ndrwxr-xr-x\t40\t1700000001\t/home/u/alpha\n";
        let entries = parse_statf_listing(raw, "/home/u").unwrap();
        assert_eq!(entries[0].name, "alpha");
        assert_eq!(entries[0].entry_type, ScpEntryType::Directory);
        assert_eq!(entries[1].name, "beta.txt");
        assert_eq!(entries[1].permissions, 0o644);
        assert_eq!(entries[1].size, 10);
    }

    #[test]
    fn statc_single_parses() {
        let info = parse_statc_single(b"directory\t755\t66\t1700000000\n")
            .unwrap()
            .unwrap();
        assert_eq!(info.entry_type, ScpEntryType::Directory);
        assert_eq!(info.mode, 0o755);
        assert_eq!(info.size, 66);
        assert_eq!(info.mtime, 1700000000);
    }

    #[test]
    fn statc_single_empty_is_none() {
        assert!(parse_statc_single(b"").unwrap().is_none());
    }

    #[test]
    fn statf_single_parses() {
        let info = parse_statf_single(b"drwxr-xr-x\t66\t1700000000\n")
            .unwrap()
            .unwrap();
        assert_eq!(info.entry_type, ScpEntryType::Directory);
        assert_eq!(info.mode, 0o755);
        assert_eq!(info.size, 66);
    }

    #[test]
    fn gnu_tree_parses() {
        let raw = b"d\t40\tsub\0f\t12\tsub/file.txt\0";
        let tree = parse_gnu_tree(raw).unwrap();
        assert_eq!(tree.len(), 2);
        assert!(tree[0].is_dir);
        assert_eq!(tree[0].rel_path, "sub");
        assert_eq!(tree[1].rel_path, "sub/file.txt");
        assert_eq!(tree[1].size, 12);
    }

    #[test]
    fn statc_tree_strips_prefix() {
        let raw = b"directory\t40\t/root/sub\nregular file\t12\t/root/sub/file.txt\n";
        let tree = parse_statc_tree(raw, "/root").unwrap();
        assert_eq!(tree[0].rel_path, "sub");
        assert!(tree[0].is_dir);
        assert_eq!(tree[1].rel_path, "sub/file.txt");
        assert_eq!(tree[1].size, 12);
        assert!(!tree[1].is_dir);
    }

    #[test]
    fn statf_tree_strips_prefix() {
        let raw = b"drwxr-xr-x\t40\t/root/sub\n-rw-r--r--\t12\t/root/sub/file.txt\n";
        let tree = parse_statf_tree(raw, "/root").unwrap();
        assert_eq!(tree[0].rel_path, "sub");
        assert!(tree[0].is_dir);
        assert_eq!(tree[1].rel_path, "sub/file.txt");
        assert!(!tree[1].is_dir);
    }

    #[test]
    fn malformed_listing_errors() {
        assert!(parse_gnu_listing(b"f\t644\0", "/d").is_err());
        assert!(parse_statc_listing(b"directory\t755\n", "/d").is_err());
    }
}
