//! OS-agnostic local-filesystem operations. Async (tokio) so they don't block
//! the Tauri command threads; platform differences are delegated to `platform`.
//!
//! Cancel-safety: `list_dir`, `mkdir`, `create_file`, and `rename` are each a
//! single OS syscall (`rename` is atomic), so dropping the future mid-`.await`
//! leaves no partial state. `delete` via `remove_dir_all` is NOT cancel-safe —
//! a dropped future can leave a partially-removed tree — but Tauri drives these
//! commands to completion, so a cancelled delete isn't a concern here.

use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::sftp::format_permissions;

use super::platform;
use super::types::{LocalEntry, LocalEntryType, LocalError};

fn modified_secs(meta: &std::fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Build a `LocalEntry` from a path and its (possibly-followed) metadata.
/// `symlink_is` reports whether the path itself is a symlink; `followed` is the
/// metadata after following it (`None` for a broken link).
fn build_entry(
    name: String,
    full_path: &Path,
    symlink_is: bool,
    followed: Option<&std::fs::Metadata>,
) -> LocalEntry {
    let (entry_type, size, permissions, modified) = match followed {
        Some(meta) => {
            let ty = if meta.is_dir() {
                LocalEntryType::Directory
            } else if meta.is_file() {
                LocalEntryType::File
            } else {
                LocalEntryType::Other
            };
            (ty, meta.len(), platform::mode_of(meta), modified_secs(meta))
        }
        // Metadata unreadable: a broken symlink if the entry itself is a link,
        // otherwise an inaccessible/vanished entry (EACCES, TOCTOU) — don't
        // mislabel those as symlinks.
        None => {
            let ty = if symlink_is {
                LocalEntryType::Symlink
            } else {
                LocalEntryType::Other
            };
            (ty, 0, 0, None)
        }
    };

    let permissions_display = if permissions == 0 {
        String::new()
    } else {
        format_permissions(permissions)
    };

    LocalEntry {
        name,
        path: full_path.to_string_lossy().into_owned(),
        entry_type,
        size,
        permissions,
        permissions_display,
        modified,
        is_symlink: symlink_is,
    }
}

/// List a local directory. Entries whose target metadata can't be read are
/// still returned (best-effort), matching how the remote listing tolerates gaps.
pub async fn list_dir(path: &str) -> Result<Vec<LocalEntry>, LocalError> {
    let followed = tokio::fs::metadata(path).await?;
    if !followed.is_dir() {
        return Err(LocalError::NotADirectory(path.to_string()));
    }

    let mut read_dir = tokio::fs::read_dir(path).await?;
    let mut entries = Vec::new();
    while let Some(entry) = read_dir.next_entry().await? {
        let full_path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();

        // file_type() reports symlink-ness from the dirent's cached d_type (no
        // extra stat on Unix); metadata() then follows to resolve type/size.
        let symlink_is = entry
            .file_type()
            .await
            .map(|ft| ft.is_symlink())
            .unwrap_or(false);
        let followed = tokio::fs::metadata(&full_path).await.ok();

        entries.push(build_entry(name, &full_path, symlink_is, followed.as_ref()));
    }
    Ok(entries)
}

/// The current user's home directory as an absolute path.
pub fn home_dir() -> Result<String, LocalError> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| LocalError::NotFound("home directory".into()))
}

pub async fn mkdir(path: &str) -> Result<(), LocalError> {
    if path.trim().is_empty() {
        return Err(LocalError::InvalidPath(path.to_string()));
    }
    tokio::fs::create_dir(path).await?;
    Ok(())
}

pub async fn create_file(path: &str) -> Result<(), LocalError> {
    if path.trim().is_empty() {
        return Err(LocalError::InvalidPath(path.to_string()));
    }
    // create_new fails if it already exists, so we never clobber a real file.
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .await?;
    Ok(())
}

pub async fn delete(path: &str, is_dir: bool) -> Result<(), LocalError> {
    if is_dir {
        tokio::fs::remove_dir_all(path).await?;
    } else {
        tokio::fs::remove_file(path).await?;
    }
    Ok(())
}

pub async fn rename(old_path: &str, new_path: &str) -> Result<(), LocalError> {
    tokio::fs::rename(old_path, new_path).await?;
    Ok(())
}

/// Launch an external editor against a local file, in place. Unlike the remote
/// `edit_external` flow there's nothing to stage or watch: the file is already
/// local, so the editor's saves land on it directly. `launch` spawns the editor
/// as a detached process and returns immediately.
pub fn edit(path: &str, editor: Option<crate::editors::EditorConfig>) -> Result<(), LocalError> {
    let p = Path::new(path);
    if !p.is_file() {
        return Err(LocalError::NotFound(path.to_string()));
    }
    let editor = editor
        .or_else(crate::editors::resolve_default)
        .ok_or_else(|| {
            LocalError::IoError("No editor found. Add one in Settings → Editors.".to_string())
        })?;
    crate::editors::launch(&editor, p).map_err(LocalError::IoError)?;
    crate::telemetry::capture(
        "edit_external",
        serde_json::json!({ "source": "local", "editor": editor.name }),
    );
    Ok(())
}

/// Copy entries into `target_dir` under de-duplicated names (never clobbers).
/// The recursive tree walk + byte copies run on a blocking thread. Returns the
/// new paths.
pub async fn copy_entries(
    sources: Vec<String>,
    target_dir: String,
) -> Result<Vec<String>, LocalError> {
    tokio::task::spawn_blocking(move || copy_entries_blocking(&sources, &target_dir))
        .await
        .map_err(|e| LocalError::IoError(format!("copy task failed: {e}")))?
}

/// Move entries into `target_dir`. Tries an atomic same-filesystem rename first
/// and falls back to copy-then-delete across devices (rename → `EXDEV`). Names
/// are de-duplicated so a move never clobbers.
pub async fn move_entries(
    sources: Vec<String>,
    target_dir: String,
) -> Result<Vec<String>, LocalError> {
    tokio::task::spawn_blocking(move || move_entries_blocking(&sources, &target_dir))
        .await
        .map_err(|e| LocalError::IoError(format!("move task failed: {e}")))?
}

fn copy_entries_blocking(sources: &[String], target_dir: &str) -> Result<Vec<String>, LocalError> {
    let target = Path::new(target_dir);
    let mut new_paths = Vec::with_capacity(sources.len());
    for source in sources {
        let src = Path::new(source);
        let name = entry_name(src, source)?;
        reject_into_self(src, target, source)?;
        let dest = target.join(deduplicate_name(target, &name));
        copy_recursive(src, &dest)?;
        new_paths.push(dest.to_string_lossy().into_owned());
    }
    Ok(new_paths)
}

fn move_entries_blocking(sources: &[String], target_dir: &str) -> Result<Vec<String>, LocalError> {
    let target = Path::new(target_dir);
    let mut new_paths = Vec::with_capacity(sources.len());
    for source in sources {
        let src = Path::new(source);
        let name = entry_name(src, source)?;
        reject_into_self(src, target, source)?;
        let dest = target.join(deduplicate_name(target, &name));
        match std::fs::rename(src, &dest) {
            Ok(()) => {}
            Err(e) if is_cross_device(&e) => {
                copy_recursive(src, &dest)?;
                remove_recursive(src)?;
            }
            Err(e) => return Err(e.into()),
        }
        new_paths.push(dest.to_string_lossy().into_owned());
    }
    Ok(new_paths)
}

fn entry_name(src: &Path, raw: &str) -> Result<String, LocalError> {
    src.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| LocalError::InvalidPath(raw.to_string()))
}

/// Refuse to copy/move a directory into itself or one of its descendants, which
/// would recurse forever. `starts_with` is component-wise, so `/a/bc` is not
/// treated as inside `/a/b`.
fn reject_into_self(src: &Path, target: &Path, raw: &str) -> Result<(), LocalError> {
    if target == src || target.starts_with(src) {
        return Err(LocalError::InvalidPath(format!(
            "Cannot move {raw} into itself"
        )));
    }
    Ok(())
}

/// De-duplicate `name` in `target_dir`: "photo.jpg" → "photo (1).jpg" if taken,
/// bumping the counter until free. Mirrors the remote `deduplicate_name`.
fn deduplicate_name(target_dir: &Path, name: &str) -> String {
    if !target_dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(pos) if pos > 0 => (&name[..pos], &name[pos..]),
        _ => (name, ""),
    };
    for i in 1u32..1000 {
        let candidate = format!("{stem} ({i}){ext}");
        if !target_dir.join(&candidate).exists() {
            return candidate;
        }
    }
    format!("{stem} (copy){ext}")
}

/// Recursively copy `src` to `dst` (which must not exist). Symlinks are
/// preserved on Unix rather than followed.
fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    let ty = std::fs::symlink_metadata(src)?.file_type();
    if ty.is_symlink() {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(std::fs::read_link(src)?, dst)?;
        }
        #[cfg(not(unix))]
        {
            std::fs::copy(src, dst)?;
        }
    } else if ty.is_dir() {
        std::fs::create_dir(dst)?;
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        std::fs::copy(src, dst)?;
    }
    Ok(())
}

fn remove_recursive(p: &Path) -> std::io::Result<()> {
    if std::fs::symlink_metadata(p)?.is_dir() {
        std::fs::remove_dir_all(p)
    } else {
        std::fs::remove_file(p)
    }
}

/// Whether a `rename` failed because source and destination live on different
/// filesystems (the signal to fall back to copy-then-delete).
fn is_cross_device(e: &std::io::Error) -> bool {
    #[cfg(unix)]
    let expected = 18; // EXDEV
    #[cfg(windows)]
    let expected = 17; // ERROR_NOT_SAME_DEVICE
    #[cfg(not(any(unix, windows)))]
    let expected = -1;
    e.raw_os_error() == Some(expected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lists_files_and_dirs_with_types() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        tokio::fs::create_dir(root.join("sub")).await.unwrap();
        tokio::fs::write(root.join("a.txt"), b"hello")
            .await
            .unwrap();

        let mut entries = list_dir(root.to_str().unwrap()).await.unwrap();
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(entries.len(), 2);

        let file = entries.iter().find(|e| e.name == "a.txt").unwrap();
        assert_eq!(file.entry_type, LocalEntryType::File);
        assert_eq!(file.size, 5);
        assert!(!file.is_symlink);

        let dir = entries.iter().find(|e| e.name == "sub").unwrap();
        assert_eq!(dir.entry_type, LocalEntryType::Directory);
    }

    #[tokio::test]
    async fn list_dir_rejects_a_file() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("f.txt");
        tokio::fs::write(&f, b"x").await.unwrap();
        let err = list_dir(f.to_str().unwrap()).await.unwrap_err();
        assert!(matches!(err, LocalError::NotADirectory(_)));
    }

    #[tokio::test]
    async fn list_dir_missing_path_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope");
        let err = list_dir(missing.to_str().unwrap()).await.unwrap_err();
        assert!(matches!(err, LocalError::NotFound(_)));
    }

    #[tokio::test]
    async fn mkdir_create_rename_delete_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();

        let dir = root.join("d");
        mkdir(dir.to_str().unwrap()).await.unwrap();
        assert!(dir.is_dir());

        let file = root.join("n.txt");
        create_file(file.to_str().unwrap()).await.unwrap();
        assert!(file.is_file());

        // create_file must not clobber an existing file.
        assert!(matches!(
            create_file(file.to_str().unwrap()).await.unwrap_err(),
            LocalError::AlreadyExists(_)
        ));

        let renamed = root.join("renamed.txt");
        rename(file.to_str().unwrap(), renamed.to_str().unwrap())
            .await
            .unwrap();
        assert!(renamed.is_file() && !file.exists());

        delete(renamed.to_str().unwrap(), false).await.unwrap();
        delete(dir.to_str().unwrap(), true).await.unwrap();
        assert!(!renamed.exists() && !dir.exists());
    }

    #[test]
    fn roots_is_non_empty() {
        assert!(!platform::roots().is_empty());
    }
}
