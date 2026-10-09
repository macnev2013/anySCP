#!/usr/bin/env bash
# Put a linuxdeploy that honours LINUXDEPLOY_EXCLUDED_LIBRARIES where the
# Tauri bundler looks for it, before `tauri build`.
#
# The bundler only downloads its own linuxdeploy (tauri-apps/binary-releases,
# built 2024-07 from 659c9db) when none is cached. That build predates
# LINUXDEPLOY_EXCLUDED_LIBRARIES (linuxdeploy 98f393c, merged 2025-08), so it
# silently bundles everything in appimage-excluded-libs.txt (#67, #134).
set -euo pipefail

version=1-alpha-20251107-1
sha256=c20cd71e3a4e3b80c3483cef793cda3f4e990aca14014d23c544ca3ce1270b4d

# Same directory as the bundler: dirs::cache_dir()/tauri.
tools_dir=${XDG_CACHE_HOME:-$HOME/.cache}/tauri
dest=$tools_dir/linuxdeploy-x86_64.AppImage

mkdir -p "$tools_dir"
curl -fsSL --retry 3 -o "$dest.tmp" \
  "https://github.com/linuxdeploy/linuxdeploy/releases/download/$version/linuxdeploy-x86_64.AppImage"
echo "$sha256  $dest.tmp" | sha256sum -c -
chmod +x "$dest.tmp"
mv "$dest.tmp" "$dest"
echo "Installed linuxdeploy $version at $dest"
