//! Find the working directory of a terminal pane's shell on the server, so the
//! file explorer can open right where the user is (issue #149).
//!
//! The SSH protocol has no way to ask for a channel's working directory, so a
//! short script runs on a side channel of the same connection. It walks up to
//! the per-connection `sshd` process, lists that process's children that own
//! a TTY (one per terminal pane, in start order) and prints each one's
//! directory. It prefers the newest descendant in the TTY's foreground process
//! group whose directory is readable, so a nested `bash` (with or without job
//! control) is followed, while a `sudo -i` root shell, whose directory isn't
//! readable, falls back to the user's own shell. The pane is then matched to
//! its shell by the order the panes were opened in.
//!
//! This relies on Linux `/proc`. On other servers the script exits non-zero
//! and the lookup yields `None`; the caller falls back to the home directory.

use std::sync::Arc;

use russh::client::Handle;
use russh::ChannelMsg;
use tokio::sync::Mutex;

use super::handler::SshClientHandler;
use crate::types::SshError;

/// POSIX `sh` script, fed on stdin to `sh -s` so the user's login shell (fish,
/// csh, …) never has to parse it. Prints `<starttime> <pid> <cwd>` per shell.
const SCRIPT: &str = r#"
p=$$
while [ -n "$p" ] && [ "$p" -gt 1 ]; do
  s=$(cat /proc/$p/stat 2>/dev/null) || exit 3
  p=${s##*) }; p=${p#* }; p=${p%% *}
  case $(cat /proc/$p/comm 2>/dev/null) in sshd*|dropbear*) break ;; esac
done
[ -n "$p" ] && [ "$p" -gt 1 ] || exit 3
cat /proc/[0-9]*/stat 2>/dev/null | awk -v P="$p" '
  { s = $0; sub(/^.*\) /, "", s); split(s, f, " ")
    ppid[$1] = f[2]; pgrp[$1] = f[3]; tty[$1] = f[5]; fg[$1] = f[6]; st[$1] = f[20]
    kids[f[2]] = kids[f[2]] " " $1 }
  END {
    for (sh in ppid) {
      if (ppid[sh] != P || tty[sh] == 0) continue
      nc = 0; top = 1; stk[1] = sh
      while (top > 0) {
        x = stk[top]; top--
        if (x != sh && pgrp[x] == fg[sh]) cand[++nc] = x
        n = split(kids[x], a, " ")
        for (i = 1; i <= n; i++) stk[++top] = a[i]
      }
      for (i = 2; i <= nc; i++) {
        x = cand[i]
        for (j = i - 1; j >= 1 && st[cand[j]] + 0 < st[x] + 0; j--) cand[j + 1] = cand[j]
        cand[j + 1] = x
      }
      out = st[sh] " " sh
      for (i = 1; i <= nc; i++) out = out " " cand[i]
      print out " " sh
    }
  }' |
  while read -r st pid procs; do
    d=
    for c in $procs; do
      d=$(readlink /proc/$c/cwd 2>/dev/null) && [ -n "$d" ] && break
      d=
    done
    printf '%s %s %s\n' "$st" "$pid" "$d"
  done
"#;

/// One shell found by the script.
#[derive(Debug, PartialEq, Eq)]
struct ShellInfo {
    start: u64,
    pid: u64,
    cwd: Option<String>,
}

/// Parse the script output into shells sorted by start order.
fn parse(out: &str) -> Vec<ShellInfo> {
    let mut shells: Vec<ShellInfo> = out
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, ' ');
            let start = parts.next()?.parse().ok()?;
            let pid = parts.next()?.parse().ok()?;
            let cwd = parts
                .next()
                .filter(|d| d.starts_with('/'))
                .map(str::to_string);
            Some(ShellInfo { start, pid, cwd })
        })
        .collect();
    shells.sort_by_key(|s| (s.start, s.pid));
    shells
}

/// Pick the directory of pane `index` out of `panes` open on the connection.
/// With a count mismatch the match is only trusted when there is one shell.
fn pick(shells: &[ShellInfo], index: usize, panes: usize) -> Option<String> {
    let shell = if shells.len() == panes {
        shells.get(index)
    } else if shells.len() == 1 {
        shells.first()
    } else {
        None
    };
    shell.and_then(|s| s.cwd.clone())
}

/// Look up the directory of pane `index` of `panes` sharing `handle`.
pub async fn shell_cwd(
    handle: Arc<Mutex<Handle<SshClientHandler>>>,
    index: usize,
    panes: usize,
) -> Result<Option<String>, SshError> {
    let mut channel = {
        let h = handle.lock().await;
        h.channel_open_session()
            .await
            .map_err(|e| SshError::ChannelError(e.to_string()))?
    };
    channel
        .exec(true, "sh -s")
        .await
        .map_err(|e| SshError::ChannelError(e.to_string()))?;
    channel
        .data(SCRIPT.as_bytes())
        .await
        .map_err(|e| SshError::ChannelError(e.to_string()))?;
    channel
        .eof()
        .await
        .map_err(|e| SshError::ChannelError(e.to_string()))?;

    let mut stdout = Vec::new();
    let mut exit_code = None;
    let read = async {
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    };
    // A wedged server must not leave the button spinning forever.
    if tokio::time::timeout(std::time::Duration::from_secs(10), read)
        .await
        .is_err()
    {
        return Ok(None);
    }
    if exit_code.unwrap_or(0) != 0 {
        return Ok(None);
    }
    Ok(pick(
        &parse(&String::from_utf8_lossy(&stdout)),
        index,
        panes,
    ))
}

/// Command that starts a split pane's shell in `dir` (#148). It runs through
/// the user's login shell, so it sticks to syntax that sh, bash, zsh, fish and
/// csh all accept, then replaces itself with the shell the pane would have
/// had anyway: the host's configured default shell, or a login `$SHELL`.
pub fn start_in_dir_command(dir: &str, default_shell: Option<&str>) -> String {
    let shell = default_shell.unwrap_or("\"$SHELL\" -l");
    format!("cd {}; exec {}", crate::scp::shell_quote(dir), shell)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_in_dir_execs_a_login_shell() {
        assert_eq!(
            start_in_dir_command("/app/files/05f5", None),
            r#"cd '/app/files/05f5'; exec "$SHELL" -l"#
        );
    }

    #[test]
    fn start_in_dir_quotes_the_path_and_keeps_the_default_shell() {
        assert_eq!(
            start_in_dir_command("/srv/it's $HOME", Some("/bin/zsh")),
            r"cd '/srv/it'\''s $HOME'; exec /bin/zsh"
        );
    }

    const OUT: &str = "5200 812 /app/logs/05f54a66\n4100 790 /home/me\n6000 900 \n";

    #[test]
    fn parses_and_sorts_by_start_time() {
        let shells = parse(OUT);
        assert_eq!(
            shells.iter().map(|s| s.pid).collect::<Vec<_>>(),
            [790, 812, 900]
        );
        assert_eq!(shells[1].cwd.as_deref(), Some("/app/logs/05f54a66"));
        assert_eq!(shells[2].cwd, None);
    }

    #[test]
    fn keeps_spaces_in_paths() {
        let shells = parse("1 2 /srv/my logs\n");
        assert_eq!(shells[0].cwd.as_deref(), Some("/srv/my logs"));
    }

    #[test]
    fn matches_pane_by_open_order() {
        let shells = parse(OUT);
        assert_eq!(pick(&shells, 0, 3).as_deref(), Some("/home/me"));
        assert_eq!(pick(&shells, 1, 3).as_deref(), Some("/app/logs/05f54a66"));
        // Unreadable directory: no guess.
        assert_eq!(pick(&shells, 2, 3), None);
    }

    #[test]
    fn single_shell_is_trusted_on_count_mismatch() {
        let shells = parse("10 20 /var/log\n");
        assert_eq!(pick(&shells, 1, 2).as_deref(), Some("/var/log"));
    }

    #[test]
    fn ambiguous_count_mismatch_gives_none() {
        let shells = parse(OUT);
        assert_eq!(pick(&shells, 0, 2), None);
        assert_eq!(pick(&[], 0, 1), None);
    }
}
