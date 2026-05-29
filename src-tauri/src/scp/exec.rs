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

use super::listing::{self, Flavor};
use super::{shell_quote, ScpEntry, ScpError};

// Re-export so callers keep using `exec::StatInfo` / `exec::TreeEntry`.
pub use super::listing::{StatInfo, TreeEntry};

type SshHandle = Arc<Mutex<Handle<SshClientHandler>>>;

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
            // ext = 1 is stderr per RFC 4254 §5.2.
            ChannelMsg::ExtendedData { data, ext: 1 } => {
                stderr.extend_from_slice(&data);
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
pub async fn home_dir(handle: Arc<Mutex<Handle<SshClientHandler>>>) -> Result<String, ScpError> {
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

/// Detect the remote's userland once. GNU has `find -printf`; busybox lacks
/// it but keeps `stat -c`; BSD/macOS have neither (only `stat -f`).
pub async fn detect_flavor(handle: SshHandle) -> Result<Flavor, ScpError> {
    let probe = "if find / -maxdepth 0 -printf '' >/dev/null 2>&1; then echo gnu; \
                 elif stat -c '%s' / >/dev/null 2>&1; then echo busybox; \
                 else echo bsd; fi";
    let out = ssh_exec_str(handle, probe).await?;
    Ok(Flavor::parse(&out).unwrap_or(Flavor::Gnu))
}

/// Stat a single path. Returns None when the path doesn't exist.
pub async fn stat(
    handle: SshHandle,
    flavor: Flavor,
    path: &str,
) -> Result<Option<StatInfo>, ScpError> {
    let cmd = match flavor {
        Flavor::Gnu | Flavor::Busybox => format!(
            "stat -c '{fmt}' -- {p} 2>/dev/null",
            fmt = listing::STATC_FMT,
            p = shell_quote(path)
        ),
        Flavor::Bsd => format!(
            "stat -f '{fmt}' -- {p} 2>/dev/null",
            fmt = listing::STATF_FMT,
            p = shell_quote(path)
        ),
    };
    let (stdout, _, exit) = ssh_exec(handle, &cmd).await?;
    if exit != 0 {
        return Ok(None);
    }
    match flavor {
        Flavor::Gnu | Flavor::Busybox => listing::parse_statc_single(&stdout),
        Flavor::Bsd => listing::parse_statf_single(&stdout),
    }
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

/// List the immediate contents of `dir`, using the right command for the
/// remote `flavor`:
/// - GNU: one `find -printf` pass (NUL-delimited).
/// - busybox: `find … -exec stat -c …` (busybox find has no `-printf`).
/// - BSD/macOS: `find … -exec stat -f …`.
pub async fn list_dir(
    handle: SshHandle,
    flavor: Flavor,
    dir: &str,
) -> Result<Vec<ScpEntry>, ScpError> {
    let q = shell_quote(dir);
    match flavor {
        Flavor::Gnu => {
            let cmd = format!(
                "find {q} -mindepth 1 -maxdepth 1 -printf '{fmt}'",
                fmt = listing::GNU_LISTING_PRINTF
            );
            let stdout = ssh_exec_ok(handle, &cmd).await?;
            listing::parse_gnu_listing(&stdout, dir)
        }
        Flavor::Busybox => {
            let cmd = format!(
                "find {q} -mindepth 1 -maxdepth 1 -exec stat -c '{fmt}' {{}} +",
                fmt = listing::STATC_FMT_NAMED
            );
            let stdout = ssh_exec_ok(handle, &cmd).await?;
            listing::parse_statc_listing(&stdout, dir)
        }
        Flavor::Bsd => {
            let cmd = format!(
                "find {q} -mindepth 1 -maxdepth 1 -exec stat -f '{fmt}' {{}} +",
                fmt = listing::STATF_FMT_NAMED
            );
            let stdout = ssh_exec_ok(handle, &cmd).await?;
            listing::parse_statf_listing(&stdout, dir)
        }
    }
}

/// Recursively enumerate everything under `dir` (excluding `dir` itself),
/// each node's path relative to `dir`. Ordering is not guaranteed — callers
/// that need dirs-before-files should sort by depth.
pub async fn enumerate_tree(
    handle: SshHandle,
    flavor: Flavor,
    dir: &str,
) -> Result<Vec<TreeEntry>, ScpError> {
    let q = shell_quote(dir);
    match flavor {
        Flavor::Gnu => {
            let cmd = format!(
                "find {q} -mindepth 1 -printf '{fmt}'",
                fmt = listing::GNU_TREE_PRINTF
            );
            let stdout = ssh_exec_ok(handle, &cmd).await?;
            listing::parse_gnu_tree(&stdout)
        }
        Flavor::Busybox => {
            let cmd = format!(
                "find {q} -mindepth 1 -exec stat -c '{fmt}' {{}} +",
                fmt = listing::STATC_TREE_FMT
            );
            let stdout = ssh_exec_ok(handle, &cmd).await?;
            listing::parse_statc_tree(&stdout, dir)
        }
        Flavor::Bsd => {
            let cmd = format!(
                "find {q} -mindepth 1 -exec stat -f '{fmt}' {{}} +",
                fmt = listing::STATF_TREE_FMT
            );
            let stdout = ssh_exec_ok(handle, &cmd).await?;
            listing::parse_statf_tree(&stdout, dir)
        }
    }
}

/// Sum (total_bytes, file_count) under a remote directory in one walk.
pub async fn dir_stats(
    handle: SshHandle,
    flavor: Flavor,
    dir: &str,
) -> Result<(u64, u32), ScpError> {
    let entries = enumerate_tree(handle, flavor, dir).await?;
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
