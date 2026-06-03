//! Cross-platform VS Code launcher for the edit-in-vscode workflow.
//!
//! On macOS, VS Code installed via the .app bundle doesn't automatically
//! add `code` to PATH. This helper tries multiple discovery strategies.

use std::path::Path;

/// Attempt to launch VS Code with `path` as the file to open.
///
/// On macOS, falls back through:
/// 1. `code` on PATH (if the user ran "Install 'code' command in PATH")
/// 2. Bundled CLI inside the .app
/// 3. `open -a "Visual Studio Code"` as a last resort
///
/// On other platforms, simply runs `code <path>`.
pub fn launch_vscode(path: &Path) -> Result<tokio::process::Child, std::io::Error> {
    #[cfg(target_os = "macos")]
    {
        // 1. Standard CLI (works when user ran "Install 'code' command in PATH")
        if let Ok(child) = tokio::process::Command::new("code").arg(path).spawn() {
            return Ok(child);
        }

        // 2. Full path to the bundled CLI inside the .app
        let bundled = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
        if let Ok(child) = tokio::process::Command::new(bundled).arg(path).spawn() {
            return Ok(child);
        }

        // 3. macOS `open` command — last resort (doesn't support --wait, but we
        //    don't use --wait anyway)
        tokio::process::Command::new("open")
            .args(["-a", "Visual Studio Code"])
            .arg(path)
            .spawn()
    }

    #[cfg(not(target_os = "macos"))]
    {
        tokio::process::Command::new("code").arg(path).spawn()
    }
}
