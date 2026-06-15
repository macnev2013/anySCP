//! External editor detection and launching.
//!
//! The "Edit in editor" feature downloads a remote file to a temp dir, opens it
//! in a desktop editor, and re-uploads on save. This module owns the two pieces
//! that are independent of the transport (SFTP/SCP/S3): finding installed
//! editors and launching one against a local file.
//!
//! Why this exists: the old code hard-coded `Command::new("code")`, which relies
//! on `code` being on `PATH`. GUI apps launched from Finder/Dock on macOS do NOT
//! inherit the shell `PATH`, so that spawn failed for most users — and the
//! failure was swallowed by the frontend, so nothing happened at all (issues
//! #12, #45, #56). Detection resolves absolute paths up front and `launch` uses
//! them directly, sidestepping `PATH` entirely, and the registry below lets the
//! app auto-detect and offer any installed editor rather than only VS Code
//! (#45, #56).
//!
//! The registry (display name + per-OS install identifiers) was compiled from
//! cross-platform research and adversarially fact-checked; see REGISTRY.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A configured or detected editor.
///
/// `args` is a command template in which the literal `{path}` is replaced with
/// the file to open; if the template contains no `{path}`, the file is appended
/// as a final argument. Serialised camelCase to match the TypeScript shape
/// (`{ name, execPath, args }`). Extra fields sent by the frontend (e.g. a UI
/// `id`) are ignored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorConfig {
    pub name: String,
    pub exec_path: String,
    #[serde(default = "default_args")]
    pub args: String,
}

fn default_args() -> String {
    "{path}".to_string()
}

// ─── Registry ───────────────────────────────────────────────────────────────

/// Per-OS install fingerprints for one editor. Each platform's detector reads
/// only the fields relevant to it (hence the broad `allow(dead_code)`).
#[allow(dead_code)]
struct EditorSpec {
    /// Display name shown in the UI.
    name: &'static str,
    /// macOS `.app` bundle names to look for under the standard app dirs.
    mac_apps: &'static [&'static str],
    /// Linux executable names to resolve on `PATH` / known dirs.
    linux_bins: &'static [&'static str],
    /// Flatpak app ids — also the filename of the wrapper in the flatpak
    /// `exports/bin` directories, so they're resolved the same way as bins.
    linux_flatpak_ids: &'static [&'static str],
    /// Windows install paths, with `%ENV%` placeholders and `*` globs for
    /// versioned directories.
    win_paths: &'static [&'static str],
    /// Bare Windows exe names to resolve via `PATH`.
    win_bins: &'static [&'static str],
    /// File-open argument template; `{path}` is substituted with the file.
    args: &'static str,
    /// TUI editors that need a terminal — excluded from auto-detection because
    /// the app launches editors as detached GUI processes.
    terminal: bool,
}

/// Convenience constructor keeping the registry literal terse.
const fn spec(
    name: &'static str,
    mac_apps: &'static [&'static str],
    linux_bins: &'static [&'static str],
    linux_flatpak_ids: &'static [&'static str],
    win_paths: &'static [&'static str],
    win_bins: &'static [&'static str],
) -> EditorSpec {
    EditorSpec {
        name,
        mac_apps,
        linux_bins,
        linux_flatpak_ids,
        win_paths,
        win_bins,
        args: "{path}",
        terminal: false,
    }
}

/// Same as `spec` but flagged as a terminal/TUI editor.
const fn term_spec(
    name: &'static str,
    mac_apps: &'static [&'static str],
    linux_bins: &'static [&'static str],
    linux_flatpak_ids: &'static [&'static str],
    win_paths: &'static [&'static str],
    win_bins: &'static [&'static str],
    args: &'static str,
) -> EditorSpec {
    EditorSpec {
        name,
        mac_apps,
        linux_bins,
        linux_flatpak_ids,
        win_paths,
        win_bins,
        args,
        terminal: true,
    }
}

/// Known editors, ordered roughly by popularity. GUI editors are auto-detected;
/// terminal editors are listed for completeness but skipped by `detect`.
#[rustfmt::skip]
const REGISTRY: &[EditorSpec] = &[
    spec("VS Code", &["Visual Studio Code.app"], &["code"], &["com.visualstudio.code"],
        &[r"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe", r"%ProgramFiles%\Microsoft VS Code\Code.exe", r"%ProgramFiles(x86)%\Microsoft VS Code\Code.exe", r"%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd", r"%ProgramFiles%\Microsoft VS Code\bin\code.cmd"],
        &["code.cmd", "Code.exe"]),
    spec("VS Code Insiders", &["Visual Studio Code - Insiders.app"], &["code-insiders"], &["com.visualstudio.code.insiders"],
        &[r"%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\Code - Insiders.exe", r"%ProgramFiles%\Microsoft VS Code Insiders\Code - Insiders.exe", r"%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd"],
        &["code-insiders.cmd", "Code - Insiders.exe"]),
    spec("Cursor", &["Cursor.app"], &["cursor"], &[],
        &[r"%LOCALAPPDATA%\Programs\cursor\Cursor.exe", r"%ProgramFiles%\cursor\Cursor.exe", r"%LOCALAPPDATA%\Programs\cursor\resources\app\bin\cursor.cmd"],
        &["cursor.cmd", "Cursor.exe"]),
    spec("Windsurf", &["Windsurf.app"], &["windsurf"], &[],
        &[r"%LOCALAPPDATA%\Programs\Windsurf\Windsurf.exe", r"%ProgramFiles%\Windsurf\Windsurf.exe", r"%LOCALAPPDATA%\Programs\Windsurf\bin\windsurf.cmd"],
        &["windsurf.cmd", "Windsurf.exe"]),
    spec("VSCodium", &["VSCodium.app", "VSCodium - Insiders.app"], &["codium", "vscodium"], &["com.vscodium.codium"],
        &[r"%LOCALAPPDATA%\Programs\VSCodium\VSCodium.exe", r"%ProgramFiles%\VSCodium\VSCodium.exe", r"%LOCALAPPDATA%\Programs\VSCodium\bin\codium.cmd", r"%ProgramFiles%\VSCodium\bin\codium.cmd"],
        &["codium.cmd", "VSCodium.exe"]),
    spec("Sublime Text", &["Sublime Text.app", "Sublime Text 3.app"], &["subl", "sublime_text"], &["com.sublimetext.three"],
        &[r"%ProgramFiles%\Sublime Text\subl.exe", r"%ProgramFiles%\Sublime Text\sublime_text.exe", r"%ProgramFiles(x86)%\Sublime Text\sublime_text.exe", r"%ProgramFiles%\Sublime Text 3\sublime_text.exe"],
        &["subl.exe", "sublime_text.exe"]),
    spec("Zed", &["Zed.app", "Zed Preview.app"], &["zed", "zeditor", "zedit"], &["dev.zed.Zed"],
        &[r"%LOCALAPPDATA%\Programs\Zed\zed.exe", r"%LOCALAPPDATA%\Zed\zed.exe"], &["zed.exe"]),
    spec("Lapce", &["Lapce.app", "Lapce Code Editor.app"], &["lapce"], &["dev.lapce.lapce"],
        &[r"%ProgramFiles%\Lapce\lapce.exe", r"%LOCALAPPDATA%\Programs\Lapce\lapce.exe", r"%LOCALAPPDATA%\lapce\lapce.exe"],
        &["lapce.exe", "Lapce.exe"]),

    // JetBrains IDEs (standalone installs + Toolbox shell-script shims on PATH).
    spec("IntelliJ IDEA", &["IntelliJ IDEA.app", "IntelliJ IDEA Ultimate.app", "IntelliJ IDEA CE.app", "IntelliJ IDEA Community Edition.app"], &["idea", "idea.sh"], &["com.jetbrains.IntelliJ-IDEA-Ultimate", "com.jetbrains.IntelliJ-IDEA-Community"],
        &[r"%ProgramFiles%\JetBrains\IntelliJ IDEA*\bin\idea64.exe", r"%LOCALAPPDATA%\Programs\IntelliJ IDEA Ultimate\bin\idea64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\IDEA-U\*\bin\idea64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\scripts\idea.cmd"],
        &["idea64.exe", "idea.cmd"]),
    spec("PyCharm", &["PyCharm.app", "PyCharm Professional.app", "PyCharm CE.app", "PyCharm Community Edition.app"], &["pycharm", "pycharm.sh"], &["com.jetbrains.PyCharm-Professional", "com.jetbrains.PyCharm-Community"],
        &[r"%ProgramFiles%\JetBrains\PyCharm*\bin\pycharm64.exe", r"%LOCALAPPDATA%\Programs\PyCharm Professional\bin\pycharm64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\PyCharm-P\*\bin\pycharm64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\scripts\pycharm.cmd"],
        &["pycharm64.exe", "pycharm.cmd"]),
    spec("WebStorm", &["WebStorm.app"], &["webstorm", "webstorm.sh"], &["com.jetbrains.WebStorm"],
        &[r"%ProgramFiles%\JetBrains\WebStorm*\bin\webstorm64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\WebStorm\*\bin\webstorm64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\scripts\webstorm.cmd"],
        &["webstorm64.exe", "webstorm.cmd"]),
    spec("GoLand", &["GoLand.app"], &["goland", "goland.sh"], &["com.jetbrains.GoLand"],
        &[r"%ProgramFiles%\JetBrains\GoLand*\bin\goland64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\GoLand\*\bin\goland64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\scripts\goland.cmd"],
        &["goland64.exe", "goland.cmd"]),
    spec("PhpStorm", &["PhpStorm.app"], &["phpstorm", "phpstorm.sh"], &["com.jetbrains.PhpStorm"],
        &[r"%ProgramFiles%\JetBrains\PhpStorm*\bin\phpstorm64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\PhpStorm\*\bin\phpstorm64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\scripts\phpstorm.cmd"],
        &["phpstorm64.exe", "phpstorm.cmd"]),
    spec("CLion", &["CLion.app"], &["clion", "clion.sh"], &["com.jetbrains.CLion"],
        &[r"%ProgramFiles%\JetBrains\CLion*\bin\clion64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\CLion\*\bin\clion64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\scripts\clion.cmd"],
        &["clion64.exe", "clion.cmd"]),
    spec("Rider", &["Rider.app", "JetBrains Rider.app"], &["rider", "rider.sh"], &["com.jetbrains.Rider"],
        &[r"%ProgramFiles%\JetBrains\JetBrains Rider*\bin\rider64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\Rider\*\bin\rider64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\scripts\rider.cmd"],
        &["rider64.exe", "rider.cmd"]),
    spec("RubyMine", &["RubyMine.app"], &["rubymine", "rubymine.sh"], &["com.jetbrains.RubyMine"],
        &[r"%ProgramFiles%\JetBrains\RubyMine*\bin\rubymine64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\RubyMine\*\bin\rubymine64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\scripts\rubymine.cmd"],
        &["rubymine64.exe", "rubymine.cmd"]),
    spec("DataGrip", &["DataGrip.app"], &["datagrip", "datagrip.sh"], &["com.jetbrains.DataGrip"],
        &[r"%ProgramFiles%\JetBrains\DataGrip*\bin\datagrip64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\DataGrip\*\bin\datagrip64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\scripts\datagrip.cmd"],
        &["datagrip64.exe", "datagrip.cmd"]),
    spec("RustRover", &["RustRover.app"], &["rustrover", "rustrover.sh"], &["com.jetbrains.RustRover"],
        &[r"%ProgramFiles%\JetBrains\RustRover*\bin\rustrover64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\RustRover\*\bin\rustrover64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\scripts\rustrover.cmd"],
        &["rustrover64.exe", "rustrover.cmd"]),
    spec("JetBrains Fleet", &["Fleet.app", "JetBrains Fleet.app", "Fleet Nightly.app"], &["fleet"], &[],
        &[r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\fleet\*\bin\Fleet.exe", r"%LOCALAPPDATA%\Programs\Fleet\Fleet.exe"], &["Fleet.exe", "fleet.cmd"]),
    spec("Android Studio", &["Android Studio.app", "Android Studio Preview.app"], &["studio.sh", "android-studio", "studio"], &["com.google.AndroidStudio"],
        &[r"%ProgramFiles%\Android\Android Studio\bin\studio64.exe", r"%LOCALAPPDATA%\Programs\Android Studio\bin\studio64.exe", r"%LOCALAPPDATA%\JetBrains\Toolbox\apps\AndroidStudio\*\bin\studio64.exe"], &["studio64.exe"]),
    spec("Xcode", &["Xcode.app"], &[], &[], &[], &[]),
    spec("Eclipse", &["Eclipse.app"], &["eclipse"], &["org.eclipse.Java"],
        &[r"%ProgramFiles%\eclipse\eclipse.exe", r"%ProgramFiles%\Eclipse Foundation\*\eclipse.exe", r"%USERPROFILE%\eclipse\*\eclipse.exe"], &["eclipse.exe"]),
    spec("Apache NetBeans", &["NetBeans.app", "Apache NetBeans.app"], &["netbeans"], &["org.apache.netbeans"],
        &[r"%ProgramFiles%\NetBeans*\bin\netbeans64.exe", r"%ProgramFiles%\NetBeans*\netbeans\bin\netbeans64.exe"], &["netbeans64.exe"]),

    // Lightweight / native GUI editors.
    spec("Kate", &[], &["kate"], &["org.kde.kate"], &[r"%ProgramFiles%\Kate\bin\kate.exe", r"%LOCALAPPDATA%\Microsoft\WindowsApps\kate.exe"], &["kate.exe"]),
    spec("KWrite", &[], &["kwrite"], &["org.kde.kwrite"], &[r"%ProgramFiles%\Kate\bin\kwrite.exe"], &["kwrite.exe"]),
    spec("GNOME Text Editor", &[], &["gnome-text-editor"], &["org.gnome.TextEditor"], &[], &[]),
    spec("gedit", &[], &["gedit"], &["org.gnome.gedit"], &[], &[]),
    spec("Geany", &[], &["geany"], &["org.geany.Geany"], &[r"%ProgramFiles%\Geany\bin\geany.exe", r"%ProgramFiles(x86)%\Geany\bin\geany.exe", r"%ProgramFiles%\Geany\geany.exe"], &["geany.exe"]),
    spec("Mousepad", &[], &["mousepad"], &["org.xfce.mousepad"], &[], &[]),
    spec("Xed", &[], &["xed"], &[], &[], &[]),
    spec("Pluma", &[], &["pluma"], &[], &[], &[]),
    spec("Bluefish", &[], &["bluefish"], &[], &[], &[]),
    spec("Leafpad", &[], &["leafpad"], &[], &[], &[]),
    spec("Notepad++", &[], &["notepad-plus-plus"], &[], &[r"%ProgramFiles%\Notepad++\notepad++.exe", r"%ProgramFiles(x86)%\Notepad++\notepad++.exe"], &["notepad++.exe"]),
    spec("Notepad", &[], &[], &[], &[r"%SystemRoot%\System32\notepad.exe", r"%SystemRoot%\notepad.exe"], &["notepad.exe"]),
    spec("Atom", &["Atom.app"], &["atom"], &["io.atom.Atom"], &[r"%LOCALAPPDATA%\atom\atom.exe", r"%LOCALAPPDATA%\atom\bin\atom.cmd"], &["atom.cmd", "atom.exe"]),
    spec("Brackets", &["Brackets.app"], &["brackets"], &[], &[r"%ProgramFiles(x86)%\Brackets\Brackets.exe", r"%ProgramFiles%\Brackets\Brackets.exe"], &["Brackets.exe"]),
    spec("Light Table", &["LightTable.app"], &["lighttable"], &[], &[r"%LOCALAPPDATA%\LightTable\LightTable.exe"], &["LightTable.exe"]),

    // macOS-only GUI editors.
    spec("Nova", &["Nova.app"], &[], &[], &[], &[]),
    spec("BBEdit", &["BBEdit.app"], &[], &[], &[], &[]),
    spec("TextMate", &["TextMate.app"], &[], &[], &[], &[]),
    spec("CotEditor", &["CotEditor.app"], &[], &[], &[], &[]),
    spec("TextEdit", &["TextEdit.app"], &[], &[], &[], &[]),

    // Vim/Neovim GUI front-ends (the TUI variants are terminal-only, below).
    spec("MacVim", &["MacVim.app"], &["mvim", "gvim"], &[], &[], &[]),
    spec("gVim", &[], &["gvim"], &[], &[r"%ProgramFiles%\Vim\vim91\gvim.exe", r"%ProgramFiles(x86)%\Vim\vim91\gvim.exe", r"%ProgramFiles(x86)%\Vim\vim90\gvim.exe"], &["gvim.exe", "gvim.bat"]),
    spec("VimR", &["VimR.app"], &[], &[], &[], &[]),
    spec("Neovide", &["Neovide.app"], &["neovide"], &[], &[], &["neovide.exe"]),
    spec("Emacs", &["Emacs.app", "Aquamacs.app"], &["emacs"], &["org.gnu.emacs"],
        &[r"%ProgramFiles%\Emacs\*\bin\runemacs.exe", r"%ProgramFiles%\Emacs\emacs-*\bin\runemacs.exe"], &["runemacs.exe"]),

    // Terminal/TUI editors — listed for completeness, skipped by auto-detect.
    term_spec("Neovim", &[], &["nvim"], &["io.neovim.nvim"], &[r"%ProgramFiles%\Neovim\bin\nvim.exe"], &["nvim.exe"], "{path}"),
    term_spec("Vim", &[], &["vim"], &["org.vim.Vim"], &[r"%ProgramFiles%\Vim\vim91\vim.exe", r"%ProgramFiles(x86)%\Vim\vim91\vim.exe"], &["vim.exe"], "{path}"),
    term_spec("Helix", &[], &["hx", "helix"], &["com.helix_editor.Helix"], &[], &["hx.exe"], "{path}"),
    term_spec("Micro", &[], &["micro"], &["io.github.zyedidia.micro"], &[], &["micro.exe"], "{path}"),
    term_spec("Nano", &[], &["nano"], &[], &[], &["nano.exe"], "{path}"),
    term_spec("Emacs (terminal)", &[], &["emacs"], &["org.gnu.emacs"], &[], &["emacs.exe"], "-nw {path}"),
];

// ─── Detection ────────────────────────────────────────────────────────────────

/// Discover installed GUI editors on this machine, with absolute exec paths.
#[cfg(target_os = "macos")]
pub fn detect() -> Vec<EditorConfig> {
    let dirs = mac_app_dirs();
    let mut out = Vec::new();
    for s in REGISTRY {
        if s.terminal {
            continue;
        }
        if let Some(path) = s
            .mac_apps
            .iter()
            .flat_map(|app| dirs.iter().map(move |d| d.join(app)))
            .find(|p| p.exists())
        {
            out.push(EditorConfig {
                name: s.name.into(),
                exec_path: path.to_string_lossy().into(),
                args: s.args.into(),
            });
        }
    }
    dedup(out)
}

/// Discover installed GUI editors on this machine, with absolute exec paths.
#[cfg(all(unix, not(target_os = "macos")))]
pub fn detect() -> Vec<EditorConfig> {
    let dirs = linux_search_dirs();
    let mut out = Vec::new();
    for s in REGISTRY {
        if s.terminal {
            continue;
        }
        // Plain binaries first, then flatpak wrappers (filename == app id, found
        // in the flatpak export dirs that linux_search_dirs() includes).
        let found = s
            .linux_bins
            .iter()
            .chain(s.linux_flatpak_ids.iter())
            .find_map(|name| which_in(&dirs, name));
        if let Some(path) = found {
            out.push(EditorConfig {
                name: s.name.into(),
                exec_path: path.to_string_lossy().into(),
                args: s.args.into(),
            });
        }
    }
    dedup(out)
}

/// Discover installed GUI editors on this machine, with absolute exec paths.
#[cfg(target_os = "windows")]
pub fn detect() -> Vec<EditorConfig> {
    let mut out = Vec::new();
    for s in REGISTRY {
        if s.terminal {
            continue;
        }
        let found = s
            .win_paths
            .iter()
            .find_map(|p| resolve_win_path(p))
            .or_else(|| s.win_bins.iter().find_map(|b| which_windows(b)));
        if let Some(path) = found {
            out.push(EditorConfig {
                name: s.name.into(),
                exec_path: path.to_string_lossy().into(),
                args: s.args.into(),
            });
        }
    }
    dedup(out)
}

/// Drop entries that resolved to the same executable, keeping the first.
fn dedup(mut v: Vec<EditorConfig>) -> Vec<EditorConfig> {
    let mut seen = std::collections::HashSet::new();
    v.retain(|e| seen.insert(e.exec_path.clone()));
    v
}

#[cfg(unix)]
fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

#[cfg(target_os = "macos")]
fn mac_app_dirs() -> Vec<PathBuf> {
    const DIRS: &[&str] = &[
        "/Applications",
        "/Applications/Utilities",
        "~/Applications",
        "~/Applications/JetBrains Toolbox",
        "/System/Applications",
        "/System/Applications/Utilities",
    ];
    DIRS.iter().map(|d| expand_tilde(d)).collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn linux_search_dirs() -> Vec<PathBuf> {
    // GUI apps often launch with a reduced PATH, so search $PATH PLUS the common
    // locations editors install into, including flatpak/snap export bins and
    // JetBrains Toolbox shim scripts.
    const EXTRA: &[&str] = &[
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/snap/bin",
        "/opt",
        "/var/lib/flatpak/exports/bin",
        "~/.local/share/flatpak/exports/bin",
        "~/.local/bin",
        "~/bin",
        "/home/linuxbrew/.linuxbrew/bin",
        "~/.local/share/JetBrains/Toolbox/scripts",
    ];
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    for e in EXTRA {
        dirs.push(expand_tilde(e));
    }
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(xdg).join("flatpak/exports/bin"));
    }
    dirs
}

/// Find `name` as a regular file in any of `dirs` (symlinks/scripts included).
#[allow(dead_code)]
fn which_in(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    dirs.iter().map(|d| d.join(name)).find(|p| p.is_file())
}

#[cfg(target_os = "windows")]
fn which_windows(bin: &str) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    which_in(&dirs, bin)
}

/// Expand `%VAR%` placeholders. Returns None if any referenced var is unset, so
/// a path that can't be resolved is simply skipped.
#[cfg(target_os = "windows")]
fn expand_env_win(s: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                out.push_str(&std::env::var(&after[..end]).ok()?);
                rest = &after[end + 1..];
            }
            None => {
                out.push_str(&rest[start..]);
                return Some(out);
            }
        }
    }
    out.push_str(rest);
    Some(out)
}

#[cfg(target_os = "windows")]
fn resolve_win_path(pat: &str) -> Option<PathBuf> {
    let expanded = expand_env_win(pat)?;
    resolve_glob(&expanded).into_iter().find(|p| p.is_file())
}

/// Resolve a path that may contain `*` wildcards in directory components into
/// all existing matches (e.g. `JetBrains\IntelliJ IDEA*\bin\idea64.exe`). No
/// recursive `**`. Used for Windows versioned install dirs.
#[allow(dead_code)]
fn resolve_glob(path: &str) -> Vec<PathBuf> {
    if !path.contains('*') {
        let pb = PathBuf::from(path);
        return if pb.exists() { vec![pb] } else { vec![] };
    }
    let segments: Vec<&str> = path.split(['/', '\\']).collect();
    // Seed the search base from the first segment (root / drive / relative).
    let first = segments[0];
    let mut current: Vec<PathBuf> = if first.is_empty() {
        vec![PathBuf::from("/")]
    } else if first.ends_with(':') {
        vec![PathBuf::from(format!("{first}\\"))]
    } else {
        vec![PathBuf::from(first)]
    };
    for seg in &segments[1..] {
        if seg.is_empty() {
            continue;
        }
        let mut next = Vec::new();
        for base in &current {
            if seg.contains('*') {
                if let Ok(rd) = std::fs::read_dir(base) {
                    for entry in rd.flatten() {
                        let name = entry.file_name();
                        let name = name.to_string_lossy();
                        if wildcard_match(seg, &name) {
                            next.push(base.join(&*name));
                        }
                    }
                }
            } else {
                let cand = base.join(seg);
                if cand.exists() {
                    next.push(cand);
                }
            }
        }
        current = next;
        if current.is_empty() {
            break;
        }
    }
    current
}

/// Case-insensitive glob match for a single path component supporting `*`.
#[allow(dead_code)]
fn wildcard_match(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let s: Vec<char> = name.to_lowercase().chars().collect();
    let (mut pi, mut si) = (0usize, 0usize);
    let (mut star, mut mark) = (None, 0usize);
    while si < s.len() {
        if pi < p.len() && (p[pi] == s[si]) {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = si;
            pi += 1;
        } else if let Some(st) = star {
            pi = st + 1;
            mark += 1;
            si = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Pick a sensible editor when the caller didn't specify one: the first detected
/// editor, preferring the popular IDEs (and the VS Code family the old
/// hard-coded path targeted).
pub fn resolve_default() -> Option<EditorConfig> {
    const PREFERRED: &[&str] = &[
        "VS Code",
        "VSCodium",
        "Cursor",
        "Windsurf",
        "Sublime Text",
        "Zed",
    ];
    let detected = detect();
    detected
        .iter()
        .find(|e| PREFERRED.contains(&e.name.as_str()))
        .cloned()
        .or_else(|| detected.into_iter().next())
}

// ─── Temp staging ─────────────────────────────────────────────────────────────

/// Build a collision-free local path for editing a remote file.
///
/// `key` uniquely identifies the remote file (e.g. session id + remote path or
/// S3 bucket + key); `file_name` is the basename shown to the editor.
///
/// All edits used to land in a flat `anyscp-edit/<file_name>`, so two remote
/// files sharing a basename — `a/compose.yml` and `b/compose.yml` — mapped to
/// the same local file. With both open in an editor, saving one re-uploaded its
/// contents to the *other's* remote path (#76). We namespace each download as
/// `anyscp-edit/<group>/<unique>/<file_name>`:
///
/// - `<group>` is a hash of `key`, so all edits of one remote file land in the
///   same readable group dir (useful when debugging the temp tree).
/// - `<unique>` is a fresh UUID per call. It isolates every edit session, which
///   buys two things the hash alone can't: a second edit of the *same* remote
///   file gets its own dir (so one save-watcher's cleanup can't delete the file
///   out from under another), and two distinct keys that happen to collide in
///   the 64-bit group hash still never share a file.
///
/// The original `file_name` is kept innermost so the editor shows the right name
/// and syntax highlighting.
pub fn edit_temp_path(key: &str, file_name: &str) -> PathBuf {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut hasher);
    let group = format!("{:016x}", hasher.finish());
    let unique = uuid::Uuid::new_v4().to_string();
    std::env::temp_dir()
        .join("anyscp-edit")
        .join(group)
        .join(unique)
        .join(file_name)
}

/// Remove a staged edit file and prune the now-empty directories it lived in,
/// stopping at (and never removing) the shared `anyscp-edit` root. Best-effort:
/// a non-empty dir — e.g. a concurrent edit of the same remote file still in its
/// own sibling dir — simply halts the walk, leaving the rest in place.
pub fn edit_temp_cleanup(local_path: &Path) {
    let _ = std::fs::remove_file(local_path);
    let mut dir = local_path.parent();
    while let Some(d) = dir {
        if d.ends_with("anyscp-edit") || std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
}

// ─── Launching ──────────────────────────────────────────────────────────────

/// Launch `editor` against `file`. Spawns and returns immediately (the caller's
/// file watcher handles save-and-re-upload, so we never pass a `--wait` flag).
/// Returns a user-facing message on failure.
pub fn launch(editor: &EditorConfig, file: &Path) -> Result<(), String> {
    let file_str = file.to_string_lossy().to_string();

    // macOS .app bundles aren't executables — open them via `open -a`, which
    // also works regardless of whether the editor's CLI shim is on PATH.
    #[cfg(target_os = "macos")]
    if editor.exec_path.ends_with(".app") {
        return std::process::Command::new("open")
            .arg("-a")
            .arg(&editor.exec_path)
            .arg(&file_str)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("Failed to open {}: {e}", editor.name));
    }

    let exec = editor.exec_path.trim();
    if exec.is_empty() {
        return Err(format!("{} has no executable path set.", editor.name));
    }
    // An absolute/relative path that doesn't exist is a misconfiguration; a bare
    // command name is left for the OS to resolve via PATH.
    if exec.contains(std::path::MAIN_SEPARATOR) && !Path::new(exec).exists() {
        return Err(format!(
            "{} not found at {exec}. Update its path in Settings → Editors.",
            editor.name
        ));
    }

    let args = build_args(&editor.args, &file_str);
    std::process::Command::new(exec)
        .args(&args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to launch {} ({exec}): {e}", editor.name))
}

/// Split an args template into individual arguments, substituting `{path}` with
/// the target file. Honours single/double quotes so a quoted token survives as
/// one argument. If the template has no `{path}`, the file is appended last.
fn build_args(template: &str, file: &str) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut has_token = false;

    for ch in template.chars() {
        match ch {
            '\'' if !in_double => {
                in_single = !in_single;
                has_token = true;
            }
            '"' if !in_single => {
                in_double = !in_double;
                has_token = true;
            }
            c if c.is_whitespace() && !in_single && !in_double => {
                if has_token {
                    args.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            c => {
                cur.push(c);
                has_token = true;
            }
        }
    }
    if has_token {
        args.push(cur);
    }

    let mut substituted = false;
    for a in args.iter_mut() {
        if a.contains("{path}") {
            *a = a.replace("{path}", file);
            substituted = true;
        }
    }
    if !substituted {
        args.push(file.to_string());
    }
    args
}

// ─── Commands ─────────────────────────────────────────────────────────────────

/// List editors detected on this machine, for the Settings → Editors picker.
#[tauri::command]
pub fn detect_editors() -> Vec<EditorConfig> {
    detect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitutes_path_placeholder() {
        assert_eq!(build_args("{path}", "/tmp/a.txt"), vec!["/tmp/a.txt"]);
        assert_eq!(
            build_args("-n -w {path}", "/tmp/a.txt"),
            vec!["-n", "-w", "/tmp/a.txt"]
        );
    }

    #[test]
    fn appends_path_when_no_placeholder() {
        assert_eq!(build_args("", "/tmp/a.txt"), vec!["/tmp/a.txt"]);
        assert_eq!(
            build_args("--reuse-window", "/tmp/a.txt"),
            vec!["--reuse-window", "/tmp/a.txt"]
        );
    }

    #[test]
    fn honours_quotes() {
        assert_eq!(
            build_args("--flag \"some value\" {path}", "/tmp/a b.txt"),
            vec!["--flag", "some value", "/tmp/a b.txt"]
        );
    }

    #[test]
    fn placeholder_inside_quoted_token() {
        assert_eq!(
            build_args("\"{path}\"", "/tmp/a b.txt"),
            vec!["/tmp/a b.txt"]
        );
    }

    #[test]
    fn wildcard_matches() {
        assert!(wildcard_match("IntelliJ IDEA*", "IntelliJ IDEA 2024.1"));
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("vim9*", "vim91"));
        assert!(!wildcard_match("PyCharm*", "IntelliJ IDEA"));
        assert!(wildcard_match("NetBeans*", "netbeans 21")); // case-insensitive
    }

    #[test]
    fn glob_resolves_versioned_dirs() {
        // Build a temp tree: <tmp>/JetBrains/IDEA 2024.1/bin/idea64.exe
        let root = std::env::temp_dir().join(format!("anyscp_glob_{}", uuid::Uuid::new_v4()));
        let bin = root.join("JetBrains").join("IDEA 2024.1").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let exe = bin.join("idea64.exe");
        std::fs::write(&exe, b"x").unwrap();

        let pattern = format!("{}/JetBrains/IDEA*/bin/idea64.exe", root.to_string_lossy());
        let matches = resolve_glob(&pattern);
        assert_eq!(matches, vec![exe]);

        // A non-matching glob yields nothing.
        let none = resolve_glob(&format!("{}/JetBrains/NOPE*/x", root.to_string_lossy()));
        assert!(none.is_empty());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn edit_temp_path_separates_same_basename() {
        // Same basename under different remote dirs must not collide (#76).
        let a = edit_temp_path("sess1\0/a/compose.yml", "compose.yml");
        let b = edit_temp_path("sess1\0/b/compose.yml", "compose.yml");
        assert_ne!(a, b);
        assert_eq!(a.file_name().unwrap(), "compose.yml");
        assert_eq!(b.file_name().unwrap(), "compose.yml");
        // Every call is isolated, so even the *same* key yields a distinct dir
        // (a second edit of one file can't clobber the first, and a hash
        // collision can't make two files share a file path).
        let a2 = edit_temp_path("sess1\0/a/compose.yml", "compose.yml");
        assert_ne!(a, a2);
        assert_eq!(a2.file_name().unwrap(), "compose.yml");
        // Namespaced under anyscp-edit/<group>/<unique>/<file>.
        let group = a.parent().unwrap().parent().unwrap();
        assert!(group.parent().unwrap().ends_with("anyscp-edit"));
        // The two edits of the same key share a group dir but differ in <unique>.
        assert_eq!(group, a2.parent().unwrap().parent().unwrap());
        assert_ne!(a.parent().unwrap(), a2.parent().unwrap());
    }

    #[test]
    fn edit_temp_cleanup_prunes_dirs_but_keeps_root() {
        let path = edit_temp_path("sess-cleanup\0/x/file.txt", "file.txt");
        let unique_dir = path.parent().unwrap().to_path_buf();
        let group_dir = unique_dir.parent().unwrap().to_path_buf();
        let root = group_dir.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&unique_dir).unwrap();
        std::fs::write(&path, b"hi").unwrap();

        edit_temp_cleanup(&path);

        assert!(!path.exists(), "file removed");
        assert!(!unique_dir.exists(), "per-edit dir pruned");
        assert!(!group_dir.exists(), "empty group dir pruned");
        assert!(root.ends_with("anyscp-edit"));
        // Root is never removed even once emptied.
        std::fs::create_dir_all(&root).unwrap();
        assert!(root.exists());
    }

    #[test]
    fn edit_temp_cleanup_halts_at_nonempty_group() {
        // Two concurrent edits of the same remote file share a group dir.
        let a = edit_temp_path("sess-concurrent\0/y/file.txt", "file.txt");
        let b = edit_temp_path("sess-concurrent\0/y/file.txt", "file.txt");
        let group = a.parent().unwrap().parent().unwrap().to_path_buf();
        assert_eq!(group, b.parent().unwrap().parent().unwrap());
        std::fs::create_dir_all(a.parent().unwrap()).unwrap();
        std::fs::create_dir_all(b.parent().unwrap()).unwrap();
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();

        // Cleaning up edit A must not touch edit B's still-live file.
        edit_temp_cleanup(&a);
        assert!(!a.exists(), "A's file removed");
        assert!(!a.parent().unwrap().exists(), "A's per-edit dir pruned");
        assert!(b.exists(), "B's file untouched");
        assert!(group.exists(), "shared group dir kept while B lives");

        std::fs::remove_dir_all(&group).ok();
    }

    #[test]
    fn registry_has_no_empty_names_and_terminal_uses_args() {
        for s in REGISTRY {
            assert!(!s.name.is_empty());
            assert!(!s.args.is_empty());
        }
        // detect() never returns terminal editors.
        for e in detect() {
            assert!(REGISTRY.iter().any(|s| s.name == e.name && !s.terminal));
        }
    }
}
