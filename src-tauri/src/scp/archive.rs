//! Compress remote files and folders into one archive on the server (#133).
//!
//! Downloading a folder of many small files is slow because every file costs
//! its own round trips. Packing them into a single archive on the server first
//! turns that into one large, streaming download.
//!
//! The archive is built by `zip` when the server has it, otherwise by gzipped
//! `tar`, which every POSIX system ships. It is written next to the source
//! entries and never overwrites anything: a taken name gets a ` (1)`, ` (2)`,
//! … suffix. Shared by the SFTP and SCP explorers, since both ride an SSH
//! connection that can run commands.

use std::sync::Arc;

use russh::client::Handle;
use serde::Serialize;
use tokio::sync::Mutex;

use super::exec::ssh_exec;
use super::shell_quote;
use crate::ssh::handler::SshClientHandler;

type SshHandle = Arc<Mutex<Handle<SshClientHandler>>>;

/// What was created.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveInfo {
    /// Absolute remote path of the new archive.
    pub path: String,
    /// File name of the new archive.
    pub name: String,
    /// `"zip"` or `"tar.gz"`.
    pub format: String,
}

/// Archive base name: the entry's own name for one entry, else "Archive".
pub fn base_name(names: &[String]) -> String {
    match names {
        [one] => one.clone(),
        _ => "Archive".to_string(),
    }
}

/// Build the remote command. It runs through the user's login shell (which
/// may be fish or csh), so the POSIX script is handed to `sh -c` as one
/// single-quoted, single-line argument.
pub fn build_command(dir: &str, names: &[String], base: &str) -> String {
    // `./name` so an entry starting with `-` is never read as an option; zip
    // strips the leading `./` from stored paths.
    let entries = names
        .iter()
        .map(|n| shell_quote(&format!("./{n}")))
        .collect::<Vec<_>>()
        .join(" ");
    let script = [
        format!("cd {} || exit 1", shell_quote(dir)),
        "if command -v zip >/dev/null 2>&1; then ext=zip; else ext=tar.gz; fi".to_string(),
        format!("n={}", shell_quote(base)),
        "out=\"$n.$ext\"; i=1".to_string(),
        "while [ -e \"$out\" ] || [ -L \"$out\" ]; do out=\"$n ($i).$ext\"; i=$((i+1)); done"
            .to_string(),
        // -y / tar's default: store symlinks as links instead of following
        // them into trees outside the selection.
        format!(
            "if [ \"$ext\" = zip ]; then zip -qry \"$out\" {entries}; \
             else tar -czf \"$out\" {entries}; fi \
             || {{ rc=$?; rm -f \"$out\"; exit $rc; }}"
        ),
        "printf '%s\\n%s' \"$ext\" \"$out\"".to_string(),
    ]
    .join("; ");
    format!("sh -c {}", shell_quote(&script))
}

/// Parse the script's `<format>\n<file name>` output.
fn parse_output(dir: &str, stdout: &str) -> Option<ArchiveInfo> {
    let (format, name) = stdout.split_once('\n')?;
    if name.is_empty() || !(format == "zip" || format == "tar.gz") {
        return None;
    }
    let path = if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    };
    Some(ArchiveInfo {
        path,
        name: name.to_string(),
        format: format.to_string(),
    })
}

/// Compress `names` (entries directly inside `dir`) into one archive in `dir`.
/// Errors are returned as user-facing text.
pub async fn compress(
    handle: SshHandle,
    dir: &str,
    names: &[String],
) -> Result<ArchiveInfo, String> {
    if names.is_empty() {
        return Err("Nothing selected to compress".into());
    }
    if names.iter().any(|n| n.is_empty() || n.contains('/')) {
        return Err("Can only compress entries inside the current folder".into());
    }
    let command = build_command(dir, names, &base_name(names));
    let (stdout, stderr, exit) = ssh_exec(handle, &command)
        .await
        .map_err(|e| e.to_string())?;
    if exit != 0 {
        let msg = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(if msg.is_empty() {
            format!("Compression failed (exit code {exit})")
        } else {
            format!("Compression failed: {msg}")
        });
    }
    parse_output(dir, &String::from_utf8_lossy(&stdout))
        .ok_or_else(|| "Compression finished but the archive name was not reported".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn names_the_archive_after_a_single_entry() {
        assert_eq!(base_name(&names(&["logs"])), "logs");
        assert_eq!(base_name(&names(&["a", "b"])), "Archive");
    }

    #[test]
    fn command_is_one_quoted_sh_argument() {
        let cmd = build_command("/srv/app", &names(&["logs", "it's"]), "Archive");
        assert!(cmd.starts_with("sh -c '"));
        assert!(!cmd.contains('\n'), "csh can't take newlines inside quotes");
        // Entries are ./-prefixed and quoted (inside the outer quoting).
        assert!(cmd.contains("./logs"));
        assert!(cmd.contains("cd '\\''/srv/app'\\'' || exit 1"));
    }

    /// Run the generated command with a real `sh` against a temp dir.
    #[cfg(unix)]
    fn run_local(dir: &std::path::Path, entries: &[String]) -> (i32, String) {
        let cmd = build_command(dir.to_str().unwrap(), entries, &base_name(entries));
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .output()
            .unwrap();
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).to_string(),
        )
    }

    #[cfg(unix)]
    #[test]
    fn creates_an_archive_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("anyscp-archive-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("logs")).unwrap();
        std::fs::write(tmp.join("logs/a.log"), "hello").unwrap();
        std::fs::write(tmp.join("-dash.txt"), "x").unwrap();

        let (rc, out) = run_local(&tmp, &names(&["logs"]));
        assert_eq!(rc, 0);
        let first = parse_output(tmp.to_str().unwrap(), &out).unwrap();
        assert!(
            first.name == "logs.zip" || first.name == "logs.tar.gz",
            "{first:?}"
        );
        assert!(tmp.join(&first.name).is_file());

        // Same name again: a numbered sibling, the first archive untouched.
        let (_, out2) = run_local(&tmp, &names(&["logs"]));
        let second = parse_output(tmp.to_str().unwrap(), &out2).unwrap();
        assert_eq!(second.name, format!("logs (1).{}", first.format));

        // Several entries, one starting with `-`.
        let (rc3, out3) = run_local(&tmp, &names(&["logs", "-dash.txt"]));
        assert_eq!(rc3, 0);
        let third = parse_output(tmp.to_str().unwrap(), &out3).unwrap();
        assert_eq!(third.name, format!("Archive.{}", first.format));

        // A missing entry fails and leaves no partial archive behind.
        let (rc4, _) = run_local(&tmp, &names(&["nope"]));
        assert_ne!(rc4, 0);
        assert!(!tmp.join(format!("nope.{}", first.format)).exists());

        std::fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn parses_output_into_a_path() {
        let info = parse_output("/srv", "zip\nlogs.zip").unwrap();
        assert_eq!(info.path, "/srv/logs.zip");
        let root = parse_output("/", "tar.gz\nArchive.tar.gz").unwrap();
        assert_eq!(root.path, "/Archive.tar.gz");
        assert_eq!(parse_output("/srv", "garbage"), None);
    }
}
