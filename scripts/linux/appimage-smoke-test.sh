#!/usr/bin/env bash
# Launch an AppImage on current Linux distros and fail if the webview dies.
#
#   scripts/linux/appimage-smoke-test.sh <file.AppImage> [image ...]
#
# Each image (default: archlinux, fedora, ubuntu:rolling — the newest Mesa
# first) gets a fresh container with Xvfb and software rendering. The check
# fails if the AppImage bundles a library from appimage-excluded-libs.txt, if
# WebKit aborts (e.g. "Could not create default EGL display", #67/#134), or if
# the app or its WebKitWebProcess is not running after SMOKE_WAIT seconds.
set -euo pipefail

appimage=${1:?usage: $0 <file.AppImage> [image ...]}
shift
images=("$@")
[ ${#images[@]} -gt 0 ] || images=(archlinux:latest fedora:latest ubuntu:rolling)

script_dir=$(cd "$(dirname "$0")" && pwd)
appimage=$(cd "$(dirname "$appimage")" && pwd)/$(basename "$appimage")

failed=()
for image in "${images[@]}"; do
  echo "::group::AppImage smoke test on $image"
  if docker run --rm -i --platform linux/amd64 \
      -e SMOKE_WAIT="${SMOKE_WAIT:-30}" \
      -v "$appimage":/smoke/app.AppImage:ro \
      -v "$script_dir/appimage-excluded-libs.txt":/smoke/excluded-libs.txt:ro \
      "$image" bash -s <<'IN_CONTAINER'
set -uo pipefail

# Host packages a desktop would have: GTK3, Mesa (software rasterizer), the
# GL/GLES dispatch libraries WebKit loads at runtime, plus
# Xvfb and the tools this check needs.
install_host_packages() {
  if command -v pacman >/dev/null; then
    grep -q '^DisableSandbox' /etc/pacman.conf || sed -i '/^\[options\]/a DisableSandbox' /etc/pacman.conf
    pacman -Syu --noconfirm --needed gtk3 mesa xorg-server-xvfb squashfs-tools procps-ng >/dev/null &&
      pacman -Q mesa wayland
  elif command -v dnf >/dev/null; then
    dnf install -y -q --disablerepo=fedora-cisco-openh264 --setopt=install_weak_deps=False gtk3 mesa-dri-drivers mesa-libEGL libglvnd-gles xorg-x11-server-Xvfb squashfs-tools procps-ng >/dev/null &&
      rpm -q mesa-libEGL libwayland-client
  else
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq && apt-get install -y -qq libgtk-3-0t64 libegl1 libgles2 libgl1-mesa-dri xvfb squashfs-tools procps >/dev/null &&
      dpkg-query -W libegl-mesa0 libwayland-client0
  fi
}
# Distro mirrors fail transiently (e.g. HTTP 503); don't report that as an
# AppImage failure on the first try.
for attempt in 1 2 3 4; do
  install_host_packages && break
  [ "$attempt" -lt 4 ] || { echo "FAIL: could not install host packages"; exit 1; }
  echo "Package install failed (attempt $attempt), retrying in 30s"
  sleep 30
done

# Extract without FUSE: the squashfs starts where the ELF runtime ends
# (e_shoff + e_shentsize * e_shnum).
cd /tmp
le() { od -An -t u"$2" -j "$1" -N "$2" /smoke/app.AppImage | tr -d ' '; }
offset=$(( $(le 40 8) + $(le 58 2) * $(le 60 2) ))
unsquashfs -q -d app -o "$offset" /smoke/app.AppImage >/dev/null || { echo "FAIL: could not extract AppImage"; exit 1; }

status=0
bundled=$(cd app && while IFS= read -r pattern; do
  case $pattern in ''|'#'*) continue ;; esac
  find . -name "$pattern" -printf '%f\n'
done </smoke/excluded-libs.txt)
if [ -n "$bundled" ]; then
  echo "FAIL: AppImage bundles libraries that must come from the host:"
  echo "$bundled" | sed 's/^/  /'
  status=1
fi

Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
sleep 2
export DISPLAY=:99 LIBGL_ALWAYS_SOFTWARE=1 NO_AT_BRIDGE=1 HOME=/tmp/home APPDIR=/tmp/app
mkdir -p "$HOME"
(cd app && exec ./AppRun) >/tmp/app.log 2>&1 &
app_pid=$!
sleep "$SMOKE_WAIT"

if grep -E "EGL_BAD|Aborting|error while loading shared libraries" /tmp/app.log; then
  echo "FAIL: webview aborted"
  status=1
fi
if ! kill -0 "$app_pid" 2>/dev/null; then
  echo "FAIL: app exited"
  status=1
fi
if ! pgrep -f WebKitWebProcess >/dev/null; then
  echo "FAIL: WebKitWebProcess is not running"
  status=1
fi
if [ "$status" -ne 0 ]; then
  echo "--- app log (tail) ---"
  tail -n 15 /tmp/app.log
else
  echo "PASS: app and WebKitWebProcess running after ${SMOKE_WAIT}s"
fi
exit "$status"
IN_CONTAINER
  then
    echo "::endgroup::"
  else
    echo "::endgroup::"
    echo "::error::AppImage smoke test failed on $image"
    failed+=("$image")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  echo "AppImage smoke test failed on: ${failed[*]}"
  exit 1
fi
echo "AppImage smoke test passed on: ${images[*]}"
