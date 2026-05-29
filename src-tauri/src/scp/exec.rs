//! Run shell commands on a fresh SSH session channel and capture
//! stdout / stderr / exit code. Used by the SCP filesystem commands —
//! SCP itself only does byte transfer; everything else (ls, mkdir, rm,
//! mv, cp, touch, realpath) is implemented by exec'ing the equivalent
//! POSIX command on the remote and parsing its output.
//!
//! Each call opens a new channel on the existing SSH connection. The
//! channel is short-lived: open, exec, drain, close.

use std::sync::Arc;
use tokio::sync::Mutex;

use russh::client::Handle;
use russh::ChannelMsg;

use crate::ssh::handler::SshClientHandler;

use super::{format_permissions, shell_quote, ScpEntry, ScpEntryType, ScpError};

/// Run `command` on the remote. Returns `(stdout, stderr, exit_code)`.
pub async fn ssh_exec(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    command: &str,
) -> Result<(Vec<u8>, Vec<u8>, i32), ScpError> {
    let mut channel = {
        let h = handle.lock().await;
        h.channel_open_session()
            .await
            .map_err(|e| ScpError::ChannelError(e.to_string()))?
    };

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| ScpError::ChannelError(format!("exec failed: {e}")))?;

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_code: Option<i32> = None;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, ext } => {
                // ext = 1 is stderr per RFC 4254 §5.2.
                if ext == 1 {
                    stderr.extend_from_slice(&data);
                }
            }
            ChannelMsg::ExitStatus { exit_status } => {
                exit_code = Some(exit_status as i32);
            }
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }

    // Some servers close without sending ExitStatus; treat as 0 then.
    Ok((stdout, stderr, exit_code.unwrap_or(0)))
}

/// Run `command` and require exit code 0. Returns stdout. Errors include
/// the captured stderr for diagnosis.
pub async fn ssh_exec_ok(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    command: &str,
) -> Result<Vec<u8>, ScpError> {
    let (stdout, stderr, exit) = ssh_exec(handle, command).await?;
    if exit != 0 {
        let stderr_str = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(ScpError::CommandFailed {
            exit_code: exit,
            stderr: stderr_str,
        });
    }
    Ok(stdout)
}

/// As [`ssh_exec_ok`] but expects UTF-8 stdout. Trims the trailing newline.
pub async fn ssh_exec_str(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    command: &str,
) -> Result<String, ScpError> {
    let stdout = ssh_exec_ok(handle, command).await?;
    let mut s = String::from_utf8(stdout)
        .map_err(|e| ScpError::ParseError(format!("non-UTF-8 stdout: {e}")))?;
    while s.ends_with('\n') || s.ends_with('\r') {
        s.pop();
    }
    Ok(s)
}

// ─── Filesystem ops ──────────────────────────────────────────────────────────

/// Resolve the remote home directory by echoing `$HOME`.
pub async fn home_dir(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
) -> Result<String, ScpError> {
    let out = ssh_exec_str(handle, r#"printf '%s' "$HOME""#).await?;
    if out.is_empty() {
        return Err(ScpError::RemoteIoError("$HOME is empty".into()));
    }
    Ok(out)
}

/// Canonicalise a remote path (resolving `.`, `..`, symlinks). Available for
/// the path bar to normalise user input; not yet wired into a command.
#[allow(dead_code)]
pub async fn realpath(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    path: &str,
) -> Result<String, ScpError> {
    // -m is GNU-only and tolerates non-existent components. Fall back to
    // -f (BSD/macOS `readlink -f`) if realpath is missing.
    let cmd = format!(
        "realpath -m {p} 2>/dev/null || readlink -f {p}",
        p = shell_quote(path)
    );
    ssh_exec_str(handle, &cmd).await
}

/// `mkdir -p` on the remote.
pub async fn mkdir_p(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    path: &str,
) -> Result<(), ScpError> {
    let cmd = format!("mkdir -p -- {}", shell_quote(path));
    ssh_exec_ok(handle, &cmd).await?;
    Ok(())
}

/// `touch` a file (also creates parent dirs if needed via `mkdir -p`).
pub async fn touch(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    path: &str,
) -> Result<(), ScpError> {
    // Resolve parent. If the path has no slash, no parent is needed.
    let parent = std::path::Path::new(path).parent().and_then(|p| {
        let s = p.to_string_lossy();
        if s.is_empty() || s == "/" {
            None
        } else {
            Some(s.into_owned())
        }
    });
    let cmd = match parent {
        Some(p) => format!(
            "mkdir -p -- {parent} && touch -- {file}",
            parent = shell_quote(&p),
            file = shell_quote(path),
        ),
        None => format!("touch -- {}", shell_quote(path)),
    };
    ssh_exec_ok(handle, &cmd).await?;
    Ok(())
}

/// Remove a file (`rm`) or directory (`rm -rf`).
pub async fn remove(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    path: &str,
    is_dir: bool,
) -> Result<(), ScpError> {
    let cmd = if is_dir {
        format!("rm -rf -- {}", shell_quote(path))
    } else {
        format!("rm -- {}", shell_quote(path))
    };
    ssh_exec_ok(handle, &cmd).await?;
    Ok(())
}

/// `mv src dst`.
pub async fn rename(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    src: &str,
    dst: &str,
) -> Result<(), ScpError> {
    let cmd = format!("mv -- {} {}", shell_quote(src), shell_quote(dst));
    ssh_exec_ok(handle, &cmd).await?;
    Ok(())
}

/// `cp -r src dst` (no overwrite of existing destination — `cp` itself
/// handles that with the same semantics as for files).
pub async fn copy(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    src: &str,
    dst: &str,
) -> Result<(), ScpError> {
    let cmd = format!(
        "cp -r -- {src} {dst}",
        src = shell_quote(src),
        dst = shell_quote(dst)
    );
    ssh_exec_ok(handle, &cmd).await?;
    Ok(())
}

/// Stat a single path. Returns None when the path doesn't exist.
pub async fn stat(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    path: &str,
) -> Result<Option<StatInfo>, ScpError> {
    // %f = type letter (we don't use stat's %f for raw mode — `find -printf`
    // does that better below). Use stat -c with type, mode, size, mtime.
    let cmd = format!(
        // Returns "<type>\t<mode_octal>\t<size>\t<mtime>" or non-zero exit if missing.
        // `stat -c` is GNU; macOS uses -f with a different format. Stick with GNU.
        "stat -c '%F\t%a\t%s\t%Y' -- {p} 2>/dev/null",
        p = shell_quote(path)
    );
    let (stdout, _, exit) = ssh_exec(handle, &cmd).await?;
    if exit != 0 {
        return Ok(None);
    }
    let line = String::from_utf8_lossy(&stdout);
    let line = line.trim_end_matches('\n');
    if line.is_empty() {
        return Ok(None);
    }
    let parts: Vec<&str> = line.split('\t').collect();
    if parts.len() != 4 {
        return Err(ScpError::ParseError(format!(
            "stat: expected 4 fields, got {} in {line:?}",
            parts.len()
        )));
    }
    let type_str = parts[0];
    let entry_type = match type_str {
        "regular file" | "regular empty file" => ScpEntryType::File,
        "directory" => ScpEntryType::Directory,
        "symbolic link" => ScpEntryType::Symlink,
        _ => ScpEntryType::Other,
    };
    let mode = u32::from_str_radix(parts[1], 8)
        .map_err(|e| ScpError::ParseError(format!("stat: bad mode {:?}: {e}", parts[1])))?;
    let size: u64 = parts[2]
        .parse()
        .map_err(|e| ScpError::ParseError(format!("stat: bad size {:?}: {e}", parts[2])))?;
    let mtime: u64 = parts[3]
        .parse()
        .map_err(|e| ScpError::ParseError(format!("stat: bad mtime {:?}: {e}", parts[3])))?;

    Ok(Some(StatInfo {
        entry_type,
        mode,
        size,
        mtime,
    }))
}

#[derive(Debug, Clone)]
pub struct StatInfo {
    pub entry_type: ScpEntryType,
    // mode/mtime are parsed for completeness; only entry_type and size are
    // consumed today (by the download enqueue path).
    #[allow(dead_code)]
    pub mode: u32,
    pub size: u64,
    #[allow(dead_code)]
    pub mtime: u64,
}

/// Whether a remote path exists. Used by deduplicate_name for copy/move.
pub async fn exists(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    path: &str,
) -> Result<bool, ScpError> {
    // `test -e` exits 0 if path exists, 1 otherwise. Any other exit is a
    // genuine error (e.g. permission denied to the parent), which we map
    // to the "doesn't exist" case to keep the dedup loop progressing —
    // the subsequent rename/copy will surface the real error.
    let cmd = format!("test -e {} && echo y || echo n", shell_quote(path));
    let out = ssh_exec_str(handle, &cmd).await?;
    Ok(out.trim() == "y")
}

// ─── Directory listing ──────────────────────────────────────────────────────

/// List the contents of `dir` using GNU `find -printf` with NUL record
/// separators. Each record: `<type>\t<mode_octal>\t<size>\t<mtime_seconds>\t<basename>\0`.
///
/// `<type>` is `f` (file), `d` (directory), `l` (symlink), `b/c/p/s` (other).
pub async fn list_dir(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    dir: &str,
) -> Result<Vec<ScpEntry>, ScpError> {
    let cmd = format!(
        "find {dir} -mindepth 1 -maxdepth 1 -printf '%y\\t%m\\t%s\\t%T@\\t%f\\0'",
        dir = shell_quote(dir)
    );
    let stdout = ssh_exec_ok(handle, &cmd).await?;

    let mut entries = Vec::new();
    for record in stdout.split(|b| *b == 0) {
        if record.is_empty() {
            continue;
        }
        let line = std::str::from_utf8(record)
            .map_err(|e| ScpError::ParseError(format!("non-UTF-8 listing record: {e}")))?;
        let parts: Vec<&str> = line.splitn(5, '\t').collect();
        if parts.len() != 5 {
            return Err(ScpError::ParseError(format!(
                "listing record has {} fields, expected 5: {line:?}",
                parts.len()
            )));
        }
        let type_char = parts[0];
        let mode_str = parts[1];
        let size_str = parts[2];
        let mtime_str = parts[3];
        let name = parts[4];

        let (entry_type, is_symlink) = match type_char {
            "f" => (ScpEntryType::File, false),
            "d" => (ScpEntryType::Directory, false),
            "l" => (ScpEntryType::Symlink, true),
            _ => (ScpEntryType::Other, false),
        };

        let permissions = u32::from_str_radix(mode_str, 8).unwrap_or(0) & 0o7777;
        let size: u64 = size_str.parse().unwrap_or(0);
        // mtime is a float ("1700000000.0000000000"). Take the integer part.
        let modified: Option<u64> = mtime_str
            .split('.')
            .next()
            .and_then(|s| s.parse().ok());

        let full_path = if dir == "/" {
            format!("/{name}")
        } else {
            format!("{dir}/{name}")
        };

        entries.push(ScpEntry {
            name: name.to_string(),
            path: full_path,
            entry_type,
            size,
            permissions,
            permissions_display: format_permissions(permissions),
            modified,
            is_symlink,
        });
    }

    // Directories first, then alphabetical within each group.
    entries.sort_by(|a, b| {
        let a_dir = a.entry_type == ScpEntryType::Directory;
        let b_dir = b.entry_type == ScpEntryType::Directory;
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// One node in a recursive directory walk, with its path relative to the
/// walk root.
#[derive(Debug, Clone)]
pub struct TreeEntry {
    /// Path relative to the walk root (never starts with `/`).
    pub rel_path: String,
    pub is_dir: bool,
    pub size: u64,
}

/// Recursively enumerate everything under `dir` (excluding `dir` itself),
/// returning each node's path relative to `dir`. Directories first within the
/// list isn't guaranteed — callers that need ordering should sort by depth.
pub async fn enumerate_tree(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    dir: &str,
) -> Result<Vec<TreeEntry>, ScpError> {
    // %y = type letter, %s = size, %P = path relative to the starting point.
    let cmd = format!(
        "find {dir} -mindepth 1 -printf '%y\\t%s\\t%P\\0'",
        dir = shell_quote(dir)
    );
    let stdout = ssh_exec_ok(handle, &cmd).await?;

    let mut entries = Vec::new();
    for record in stdout.split(|b| *b == 0) {
        if record.is_empty() {
            continue;
        }
        let line = std::str::from_utf8(record)
            .map_err(|e| ScpError::ParseError(format!("non-UTF-8 tree record: {e}")))?;
        let parts: Vec<&str> = line.splitn(3, '\t').collect();
        if parts.len() != 3 {
            return Err(ScpError::ParseError(format!(
                "tree record has {} fields, expected 3: {line:?}",
                parts.len()
            )));
        }
        let is_dir = parts[0] == "d";
        let size: u64 = parts[1].parse().unwrap_or(0);
        let rel_path = parts[2].to_string();
        if rel_path.is_empty() {
            continue;
        }
        entries.push(TreeEntry {
            rel_path,
            is_dir,
            size,
        });
    }
    Ok(entries)
}

/// Sum (total_bytes, file_count) under a remote directory in one `find` pass.
pub async fn dir_stats(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    dir: &str,
) -> Result<(u64, u32), ScpError> {
    let entries = enumerate_tree(handle, dir).await?;
    let mut bytes = 0u64;
    let mut count = 0u32;
    for e in &entries {
        if !e.is_dir {
            bytes += e.size;
            count += 1;
        }
    }
    Ok((bytes, count))
}

/// Pick a name in `target_dir` that doesn't collide. Same semantics as the
/// SFTP equivalent: appends ` (1)`, ` (2)`, ... before the file extension.
pub async fn deduplicate_name(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    target_dir: &str,
    name: &str,
) -> Result<String, ScpError> {
    let base_path = if target_dir == "/" {
        format!("/{name}")
    } else {
        format!("{target_dir}/{name}")
    };

    if !exists(handle.clone(), &base_path).await? {
        return Ok(name.to_string());
    }

    let (stem, ext) = match name.rfind('.') {
        Some(pos) if pos > 0 => (&name[..pos], &name[pos..]),
        _ => (name, ""),
    };

    for i in 1u32..1000 {
        let candidate = format!("{stem} ({i}){ext}");
        let candidate_path = if target_dir == "/" {
            format!("/{candidate}")
        } else {
            format!("{target_dir}/{candidate}")
        };
        if !exists(handle.clone(), &candidate_path).await? {
            return Ok(candidate);
        }
    }

    Ok(format!("{stem} (copy){ext}"))
}
