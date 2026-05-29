#!/usr/bin/env bash
# Entry point for the e2e runner container.
#
# Steps:
#   1. Wait for the linked sshd-pass and sshd-key containers to accept TCP.
#   2. Install JS deps for the app + the e2e harness.
#   3. Build the Tauri debug binary (cached across runs via volume).
#   4. Launch xvfb + dbus, then run WebdriverIO.
set -euo pipefail

cd /workspace

ANYSCP_BIN="src-tauri/target/debug/anyscp"

# ── 1. Wait for sshd containers ───────────────────────────────────────────────
wait_for() {
    local host="$1" port="$2" name="$3"
    echo "[entrypoint] waiting for $name ($host:$port)..."
    for _ in $(seq 1 60); do
        if (echo > "/dev/tcp/$host/$port") >/dev/null 2>&1; then
            echo "[entrypoint] $name ready"
            return 0
        fi
        sleep 1
    done
    echo "[entrypoint] timed out waiting for $name" >&2
    return 1
}

wait_for "${SSHD_PASS_HOST:-sshd-pass}" "${SSHD_PASS_PORT:-2222}" sshd-pass
wait_for "${SSHD_KEY_HOST:-sshd-key}"   "${SSHD_KEY_PORT:-2222}"   sshd-key
wait_for "${SSHD_SCP_HOST:-sshd-scp}"   "${SSHD_SCP_PORT:-2222}"   sshd-scp
wait_for "${SSHD_SCP_BUSYBOX_HOST:-sshd-scp-busybox}" "${SSHD_SCP_BUSYBOX_PORT:-2222}" sshd-scp-busybox

# ── 2. Install JS deps ────────────────────────────────────────────────────────
echo "[entrypoint] installing app deps"
pnpm install --frozen-lockfile=false

echo "[entrypoint] linking pre-baked e2e harness deps from /opt/e2e"
# Deps were installed at image build time in /opt/e2e (see Dockerfile).
# Symlink them into the bind-mounted tests/e2e/ so WDIO can resolve them.
rm -rf tests/e2e/node_modules tests/e2e/pnpm-lock.yaml tests/e2e/package-lock.json
ln -sfn /opt/e2e/node_modules tests/e2e/node_modules

# ── 3. Build Tauri binary if missing or source changed ───────────────────────
# Rebuild if: binary is missing, OR E2E_FORCE_BUILD is set, OR any tracked
# source file is newer than the binary (otherwise frontend changes silently
# go missing because Tauri embeds dist/ at compile time).
needs_build=0
if [[ ! -x "$ANYSCP_BIN" ]]; then
    needs_build=1
elif [[ -n "${E2E_FORCE_BUILD:-}" ]]; then
    needs_build=1
elif find src src-tauri/src src-tauri/Cargo.toml src-tauri/tauri.conf.json \
        index.html vite.config.ts \
        -newer "$ANYSCP_BIN" -print -quit 2>/dev/null | grep -q .; then
    needs_build=1
fi

if [[ $needs_build -eq 1 ]]; then
    echo "[entrypoint] building anyscp (debug, frontend embedded)"
    # Use `tauri build --debug --no-bundle`, NOT `cargo build`:
    #   - `cargo build` alone produces a binary that expects the frontend at
    #     tauri.conf.json's devUrl (http://localhost:1420) — there's no Vite
    #     in the container, so the webview shows "Connection refused".
    #   - `tauri build` runs the codegen step that embeds the bundled
    #     `dist/` into the binary so it serves over the tauri://localhost
    #     custom protocol.
    #   - `--no-bundle` skips the installer/AppImage step we don't need.
    pnpm tauri build --debug --no-bundle
else
    echo "[entrypoint] reusing existing binary at $ANYSCP_BIN (sources unchanged)"
fi

# ── 4. Start Xvfb + x11vnc, then run WDIO ─────────────────────────────────────
# Credentials use the kernel keyring (keyutils) via ANYSCP_TEST_KEYRING set in
# docker-compose.yml. No dbus/gnome-keyring/libsecret dance needed.

# Start Xvfb on :99 manually (so x11vnc can attach to the same display).
echo "[entrypoint] starting Xvfb :99 (1280x800x24)"
Xvfb :99 -screen 0 1280x800x24 -ac >/tmp/xvfb.log 2>&1 &
export DISPLAY=:99
# Wait for X server socket
for _ in $(seq 1 30); do
    [ -e /tmp/.X11-unix/X99 ] && break
    sleep 0.2
done

# Start x11vnc attached to :99 so anyone on port 5900 can watch the suite live.
# -nopw is fine — this only listens on the docker-internal network unless the
# port is published, which it is in docker-compose.yml.
echo "[entrypoint] starting x11vnc on :5900"
x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -quiet -bg \
    -o /tmp/x11vnc.log

echo "[entrypoint] >>> VNC ready — connect to localhost:5900 to watch <<<"

echo "[entrypoint] running webdriverio (inside a fresh kernel keyring session)"
cd tests/e2e
# Optional spec override — `make screenshots` sets WDIO_SPEC to run only the
# capture driver instead of the full suite.
wdio_args=()
if [[ -n "${WDIO_SPEC:-}" ]]; then
    echo "[entrypoint] WDIO_SPEC=$WDIO_SPEC"
    wdio_args+=(--spec "$WDIO_SPEC")
fi
# Wrap the test process in `keyctl session -` so the Tauri app's keyutils
# keyring backend has a session keyring to write to. Without it, every
# keyctl syscall returns EACCES → "PermissionDenied" from anyscp's vault.
exec keyctl session - ./node_modules/.bin/wdio run wdio.conf.ts "${wdio_args[@]}"
