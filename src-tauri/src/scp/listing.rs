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
    /// Lowest-common-denominator POSIX: no `find -printf`, no usable `stat`
    /// (e.g. stripped busybox / Buildroot where the `stat` applet is compiled
    /// out, ancient or minimal embedded userlands). Everything is derived by
    /// parsing `ls -l` output, which is mandated by POSIX and present even on
    /// the most minimal systems — this is the same approach WinSCP uses in SCP
    /// mode. Also used as the universal fallback when a flavor-specific
    /// listing command fails (see [`super::exec::list_dir`]).
    Posix,
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
            Flavor::Posix => "posix",
        }
    }

    pub fn parse(s: &str) -> Option<Flavor> {
        match s.trim() {
            "gnu" => Some(Flavor::Gnu),
            "busybox" => Some(Flavor::Busybox),
            "bsd" => Some(Flavor::Bsd),
            "posix" => Some(Flavor::Posix),
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

// `ls`-based commands for the universal POSIX fallback. `ls -l` is mandated by
// POSIX and present on every userland (unlike `stat`/`find -printf`), so these
// work where the machine-readable paths don't. `LC_ALL=C` pins month names to
// the English C-locale form the parser expects; `--` guards leading-dash names.
/// `ls` flags for a single-directory listing (long format, include dotfiles).
pub const LS_LISTING_ARGS: &str = "LC_ALL=C ls -la --";
/// `ls` flags for a recursive tree walk (long format, recursive).
pub const LS_TREE_ARGS: &str = "LC_ALL=C ls -laR --";
/// `ls` flags to stat a single path (long format, directory-as-entry via `-d`).
pub const LS_STAT_ARGS: &str = "LC_ALL=C ls -lad --";

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

// ─── `ls -l` parsers (universal POSIX fallback) ──────────────────────────────
//
// `ls -l` long-format output is the lowest common denominator: it works on
// GNU, busybox (including stripped builds with no `stat`), and BSD/macOS. The
// column order is identical everywhere:
//
//     <perms> <links> <owner> <group> <size> <month> <day> <time-or-year> <name>
//
// Only the inter-column whitespace differs. We anchor on the date triplet
// (`<Mon> <DD> <HH:MM|YYYY>`) rather than counting columns, because the
// link/owner/group columns are variable-width and device files split the size
// into `major, minor`. Type and permission bits come from the mode string's
// leading char + rwx triads — never from a localizable human word — so the
// parser is immune to locale and to GNU/busybox `stat %F` wording differences.
//
// Trade-off: plain `ls` has no NUL record separator and no machine-readable
// mtime, so (a) names containing a newline are unparseable (same inherent
// limit as the existing busybox/BSD `-exec stat` paths) and (b) `modified` is
// reported as `None` — acceptable for a fallback that exists to make otherwise
// invisible files visible.

/// One parsed `ls -l` entry line. Borrows `name`/`target` from the input.
struct LsLine<'a> {
    entry_type: ScpEntryType,
    is_symlink: bool,
    mode: u32,
    size: u64,
    name: &'a str,
}

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

fn is_month(tok: &str) -> bool {
    MONTHS.contains(&tok)
}

/// A day-of-month token: 1..=31 (`ls` space-pads single digits, so the token
/// itself is never blank).
fn is_day(tok: &str) -> bool {
    matches!(tok.parse::<u32>(), Ok(d) if (1..=31).contains(&d))
}

/// The third date token is either a clock time `HH:MM` (recent files) or a
/// 4-digit year (older files).
fn is_time_or_year(tok: &str) -> bool {
    if let Some((h, m)) = tok.split_once(':') {
        return h.len() <= 2
            && m.len() == 2
            && h.parse::<u32>().is_ok()
            && m.parse::<u32>().is_ok();
    }
    tok.len() == 4 && tok.chars().all(|c| c.is_ascii_digit())
}

/// Map an `ls` mode string (e.g. `drwxr-xr-x`, possibly with a trailing `+`/`.`
/// ACL/SELinux marker) to entry type + symlink flag + permission bits.
fn type_from_ls_mode(mode_str: &str) -> Option<(ScpEntryType, bool, u32)> {
    let first = mode_str.chars().next()?;
    // Need the type char plus 9 rwx chars.
    if mode_str.len() < 10 {
        return None;
    }
    let (entry_type, is_symlink) = match first {
        '-' => (ScpEntryType::File, false),
        'd' => (ScpEntryType::Directory, false),
        'l' => (ScpEntryType::Symlink, true),
        'b' | 'c' | 'p' | 's' => (ScpEntryType::Other, false),
        _ => return None,
    };
    // rwx triads are the 9 chars after the type char.
    let rwx: String = mode_str.chars().skip(1).take(9).collect();
    Some((entry_type, is_symlink, rwx_to_mode(&rwx)))
}

/// Split a line into (byte_offset, token) pairs on runs of spaces/tabs, so the
/// caller can recover the exact remainder (the filename) from the original
/// bytes without losing internal spacing.
fn tokens_with_offsets(line: &str) -> Vec<(usize, &str)> {
    let bytes = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        while i < bytes.len() && (bytes[i] == b' ' || bytes[i] == b'\t') {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let start = i;
        while i < bytes.len() && bytes[i] != b' ' && bytes[i] != b'\t' {
            i += 1;
        }
        out.push((start, &line[start..i]));
    }
    out
}

/// Parse a single `ls -l` entry line. Returns `None` for non-entry lines (the
/// `total N` header, `ls -R` `path:` headers, blanks) and for `.`/`..`.
fn parse_ls_line(line: &str) -> Option<LsLine<'_>> {
    let line = line.trim_end_matches('\r');
    let toks = tokens_with_offsets(line);
    if toks.len() < 6 {
        return None;
    }
    let (entry_type, is_symlink, mode) = type_from_ls_mode(toks[0].1)?;

    // Find the date anchor: <Mon> <DD> <HH:MM|YYYY>. Start past the mandatory
    // perms/links/owner/group/size columns (index >= 4) to avoid matching an
    // owner/group literally named like a month.
    let date_idx = (4..toks.len().saturating_sub(2)).find(|&i| {
        is_month(toks[i].1) && is_day(toks[i + 1].1) && is_time_or_year(toks[i + 2].1)
    })?;

    // Size is the token just before the month. Device nodes show `major, minor`
    // there, which won't parse — treat as 0 (and they're typed `Other` anyway).
    let size: u64 = toks[date_idx - 1].1.parse().unwrap_or(0);

    // The name is everything after the time/year token (preserving any internal
    // spaces). Skip exactly the single separating space ls emits.
    let time_tok = toks[date_idx + 2];
    let name_start = time_tok.0 + time_tok.1.len();
    let mut name = line[name_start..].trim_start_matches([' ', '\t']);

    // For symlinks, strip the ` -> target` suffix; keep just the link's name.
    if is_symlink {
        if let Some((left, _target)) = name.split_once(" -> ") {
            name = left;
        }
    }

    if name.is_empty() || name == "." || name == ".." {
        return None;
    }

    Some(LsLine {
        entry_type,
        is_symlink,
        mode,
        size,
        name,
    })
}

/// Parse `ls -la <dir>` output into directory entries.
pub fn parse_ls_listing(stdout: &[u8], dir: &str) -> Result<Vec<ScpEntry>, ScpError> {
    let text = String::from_utf8_lossy(stdout);
    let mut out = Vec::new();
    for line in text.lines() {
        if let Some(e) = parse_ls_line(line) {
            out.push(mk_entry(
                e.name,
                join_remote(dir, e.name),
                e.entry_type,
                e.is_symlink,
                e.mode,
                e.size,
                None, // ls has no machine-readable mtime; omit rather than guess
            ));
        }
    }
    sort_entries(&mut out);
    Ok(out)
}

/// Parse `ls -lad <path>` output (a single entry) into [`StatInfo`].
pub fn parse_ls_single(stdout: &[u8]) -> Result<Option<StatInfo>, ScpError> {
    let text = String::from_utf8_lossy(stdout);
    for line in text.lines() {
        if let Some(e) = parse_ls_line_allow_self(line) {
            return Ok(Some(StatInfo {
                entry_type: e.entry_type,
                mode: e.mode,
                size: e.size,
                mtime: 0,
            }));
        }
    }
    Ok(None)
}

/// Like [`parse_ls_line`] but does not reject `.`/`..` — `ls -lad -- <path>`
/// echoes the path verbatim as the name, which is fine, but a `-d` on `.` would
/// otherwise be dropped. Used only by single-path stat.
fn parse_ls_line_allow_self(line: &str) -> Option<LsLine<'_>> {
    let line = line.trim_end_matches('\r');
    let toks = tokens_with_offsets(line);
    if toks.len() < 6 {
        return None;
    }
    let (entry_type, is_symlink, mode) = type_from_ls_mode(toks[0].1)?;
    let date_idx = (4..toks.len().saturating_sub(2)).find(|&i| {
        is_month(toks[i].1) && is_day(toks[i + 1].1) && is_time_or_year(toks[i + 2].1)
    })?;
    let size: u64 = toks[date_idx - 1].1.parse().unwrap_or(0);
    let time_tok = toks[date_idx + 2];
    let name_start = time_tok.0 + time_tok.1.len();
    let mut name = line[name_start..].trim_start_matches([' ', '\t']);
    if is_symlink {
        if let Some((left, _)) = name.split_once(" -> ") {
            name = left;
        }
    }
    if name.is_empty() {
        return None;
    }
    Some(LsLine {
        entry_type,
        is_symlink,
        mode,
        size,
        name,
    })
}

/// Parse `ls -laR <dir>` output into a relative-path tree (excluding `dir`).
///
/// `ls -R` emits one block per directory, introduced by a `<path>:` header line
/// and followed by that directory's `ls -l` listing, blocks separated by a
/// blank line. We track the current header to resolve each entry's full path,
/// then make it relative to `dir`.
pub fn parse_ls_tree(stdout: &[u8], dir: &str) -> Result<Vec<TreeEntry>, ScpError> {
    let text = String::from_utf8_lossy(stdout);
    let root = dir.trim_end_matches('/');
    let prefix = format!("{root}/");
    let mut out = Vec::new();
    // Current directory context. The first block's header may be absent when
    // `ls` lists a single directory's contents inline; default to `dir`.
    let mut current = dir.to_string();
    for line in text.lines() {
        let trimmed = line.trim_end_matches('\r');
        if trimmed.is_empty() {
            continue;
        }
        // A `path:` header: a line ending in ':' that is not an entry line.
        if trimmed.ends_with(':') && parse_ls_line(trimmed).is_none() {
            current = trimmed[..trimmed.len() - 1].to_string();
            continue;
        }
        let Some(e) = parse_ls_line(trimmed) else {
            continue;
        };
        let full = join_remote(&current, e.name);
        let rel = full.strip_prefix(&prefix).unwrap_or(&full);
        if rel.is_empty() || rel == root {
            continue;
        }
        out.push(TreeEntry {
            rel_path: rel.to_string(),
            is_dir: e.entry_type == ScpEntryType::Directory,
            size: e.size,
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
        for f in [Flavor::Gnu, Flavor::Busybox, Flavor::Bsd, Flavor::Posix] {
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

    // ─── ls -l fallback parser ───────────────────────────────────────────────

    #[test]
    fn ls_listing_gnu() {
        // GNU coreutils `ls -la`: single-space-padded columns, `total` header.
        let raw = b"total 12\n\
            drwxr-xr-x  3 root root 4096 Jun  7 12:30 .\n\
            drwxr-xr-x 20 root root 4096 Jun  1 09:00 ..\n\
            -rw-r--r--  1 root root   12 Jun  7 12:34 seed.txt\n\
            drwxr-xr-x  2 root root 4096 Jun  7 12:30 seeddir\n\
            lrwxrwxrwx  1 root root    8 Jun  7 12:31 link -> seed.txt\n";
        let entries = parse_ls_listing(raw, "/home/u").unwrap();
        // `.`/`..` and the `total` header are dropped; dirs sort first.
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "seeddir");
        assert_eq!(entries[0].entry_type, ScpEntryType::Directory);
        assert_eq!(entries[0].path, "/home/u/seeddir");
        assert_eq!(entries[1].name, "link");
        assert!(entries[1].is_symlink);
        assert_eq!(entries[1].entry_type, ScpEntryType::Symlink);
        assert_eq!(entries[2].name, "seed.txt");
        assert_eq!(entries[2].size, 12);
        assert_eq!(entries[2].permissions, 0o644);
        assert_eq!(entries[2].modified, None);
    }

    #[test]
    fn ls_listing_busybox_wide_columns_and_year() {
        // busybox `ls -la`: wider padding, and the `Mon DD  YYYY` form for the
        // older `..` entry. This is the Buildroot/stripped-busybox case (#3).
        let raw = b"total 8\n\
            drwxr-xr-x    3 root     root          4096 Jun  7 12:30 .\n\
            drwxr-xr-x   20 root     root          4096 Jun  1  2025 ..\n\
            -rw-r--r--    1 root     root            12 Jun  7 12:34 seed.txt\n\
            drwxr-xr-x    2 root     root          4096 Jun  7 12:30 seeddir\n\
            lrwxrwxrwx    1 root     root             8 Jun  7 12:31 link -> seed.txt\n";
        let entries = parse_ls_listing(raw, "/home/testuser").unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "seeddir");
        assert_eq!(entries[1].name, "link");
        assert_eq!(entries[1].path, "/home/testuser/link");
        assert_eq!(entries[2].name, "seed.txt");
        assert_eq!(entries[2].size, 12);
    }

    #[test]
    fn ls_listing_bsd() {
        let raw = b"total 16\n\
            drwxr-xr-x   4 root  wheel   128 Jun  7 12:30 .\n\
            drwxr-xr-x  20 root  wheel   640 Jun  1 09:00 ..\n\
            -rw-r--r--   1 root  wheel    12 Jun  7 12:34 seed.txt\n\
            drwxr-xr-x   2 root  wheel    64 Jun  7 12:30 seeddir\n\
            lrwxr-xr-x   1 root  wheel     8 Jun  7 12:31 link -> seed.txt\n";
        let entries = parse_ls_listing(raw, "/home/u").unwrap();
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].name, "seeddir");
        assert_eq!(entries[2].name, "seed.txt");
        assert_eq!(entries[2].size, 12);
    }

    #[test]
    fn ls_listing_root_dir_paths() {
        let raw = b"drwxr-xr-x 2 root root 4096 Jun  7 12:30 etc\n";
        let entries = parse_ls_listing(raw, "/").unwrap();
        assert_eq!(entries[0].path, "/etc");
    }

    #[test]
    fn ls_listing_name_with_spaces() {
        let raw = b"-rw-r--r-- 1 root root 0 Jun  7 12:35 a file with spaces.txt\n";
        let entries = parse_ls_listing(raw, "/d").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "a file with spaces.txt");
        assert_eq!(entries[0].path, "/d/a file with spaces.txt");
    }

    #[test]
    fn ls_listing_special_perm_bits() {
        // setuid binary + sticky dir round-trip through rwx_to_mode.
        let raw = b"-rwsr-xr-x 1 root root 1234 Jun  7 12:34 sudo\n\
            drwxrwxrwt 5 root root 4096 Jun  7 12:34 tmp\n";
        let entries = parse_ls_listing(raw, "/x").unwrap();
        // dir first
        assert_eq!(entries[0].name, "tmp");
        assert_eq!(entries[0].permissions, 0o1777);
        assert_eq!(entries[1].name, "sudo");
        assert_eq!(entries[1].permissions, 0o4755);
    }

    #[test]
    fn ls_listing_selinux_acl_marker_tolerated() {
        // A trailing '.'/'+' after the rwx triads (SELinux/ACL) must not break.
        let raw = b"drwxr-xr-x. 2 root root 4096 Jun  7 12:30 sys\n\
            -rw-rw-r--+ 1 root root   10 Jun  7 12:34 acl.txt\n";
        let entries = parse_ls_listing(raw, "/x").unwrap();
        assert_eq!(entries[0].name, "sys");
        assert_eq!(entries[0].entry_type, ScpEntryType::Directory);
        assert_eq!(entries[1].name, "acl.txt");
        assert_eq!(entries[1].permissions, 0o664);
    }

    #[test]
    fn ls_listing_device_file_is_other() {
        // Device nodes show `major, minor` in the size column.
        let raw = b"crw-rw-rw- 1 root root 1, 3 Jun  7 12:00 null\n";
        let entries = parse_ls_listing(raw, "/dev").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "null");
        assert_eq!(entries[0].entry_type, ScpEntryType::Other);
    }

    #[test]
    fn ls_listing_empty_dir() {
        // A genuinely empty directory: just the total line (or nothing).
        assert!(parse_ls_listing(b"total 0\n", "/x").unwrap().is_empty());
        assert!(parse_ls_listing(b"", "/x").unwrap().is_empty());
    }

    #[test]
    fn ls_single_parses() {
        let info = parse_ls_single(b"drwxr-xr-x 2 root root 4096 Jun  7 12:30 /home/u/dir\n")
            .unwrap()
            .unwrap();
        assert_eq!(info.entry_type, ScpEntryType::Directory);
        assert_eq!(info.mode, 0o755);
        assert_eq!(info.size, 4096);
    }

    #[test]
    fn ls_single_file() {
        let info = parse_ls_single(b"-rw-r--r-- 1 root root 42 Jun  7 12:34 /home/u/f.txt\n")
            .unwrap()
            .unwrap();
        assert_eq!(info.entry_type, ScpEntryType::File);
        assert_eq!(info.size, 42);
    }

    #[test]
    fn ls_single_missing_is_none() {
        // stderr is captured separately; empty stdout means not found.
        assert!(parse_ls_single(b"").unwrap().is_none());
    }

    #[test]
    fn ls_tree_parses() {
        // `ls -laR` output: per-directory blocks with `path:` headers.
        let raw = b"/root:\n\
            total 8\n\
            drwxr-xr-x 3 root root 4096 Jun  7 12:30 .\n\
            drwxr-xr-x 5 root root 4096 Jun  7 12:00 ..\n\
            -rw-r--r-- 1 root root   12 Jun  7 12:34 top.txt\n\
            drwxr-xr-x 2 root root 4096 Jun  7 12:30 sub\n\
            \n\
            /root/sub:\n\
            total 4\n\
            drwxr-xr-x 2 root root 4096 Jun  7 12:30 .\n\
            drwxr-xr-x 3 root root 4096 Jun  7 12:30 ..\n\
            -rw-r--r-- 1 root root   34 Jun  7 12:31 inner.txt\n";
        let tree = parse_ls_tree(raw, "/root").unwrap();
        // top.txt, sub, sub/inner.txt — 3 nodes, root itself excluded.
        assert_eq!(tree.len(), 3);
        let top = tree.iter().find(|t| t.rel_path == "top.txt").unwrap();
        assert!(!top.is_dir);
        assert_eq!(top.size, 12);
        let sub = tree.iter().find(|t| t.rel_path == "sub").unwrap();
        assert!(sub.is_dir);
        let inner = tree.iter().find(|t| t.rel_path == "sub/inner.txt").unwrap();
        assert!(!inner.is_dir);
        assert_eq!(inner.size, 34);
    }
}
