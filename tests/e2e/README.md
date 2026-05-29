# anySCP E2E tests

End-to-end test suite that drives the real Tauri app through `tauri-driver` +
WebKitWebDriver, against real SSH servers (linuxserver/openssh-server in
Docker). Everything runs in containers so the same setup works on dev
machines (incl. Arch, where `WebKitWebDriver` is not packaged) and CI.

## Run

From the repo root:

```bash
make e2e            # full suite — first run builds the image (~5–10 min)
make e2e-shell      # interactive shell in the runner (debug a failing spec)
make e2e-logs       # tail runner logs while a run is in progress
make e2e-clean      # wipe image + cached build volumes
```

## Test report (Markdown)

After every run, **`tests/e2e/report.md`** is written. It contains:

- A summary of `passed/total` for the whole run and per spec file
- For each failure: the error message, stack trace, video path, HTML dump
  path, and the URL the webview was on at the time
- A list of passing tests at the bottom

Designed to be pasted as-is into a chat / issue. Per-test data is also
kept as NDJSON at `tests/e2e/.test-records.ndjson` if you want to
post-process it yourself.

## Video recordings

Every spec records an mp4 of the Xvfb display under `tests/e2e/videos/`
(via ffmpeg + x11grab, 15 fps, ultrafast h264). Both passing and failing
specs are kept — delete the directory to reclaim disk if you don't need
them. The WDIO output prints the video path under each test:

```
[wdio] FAIL: opens a terminal and runs a command
[wdio]   video: tests/e2e/videos/2026-…__connect_password_-opens_a_terminal….mp4
```

On failure, the HTML dump + URL are also saved under `screenshots/`.

## Watching the app run (VNC)

The runner publishes a VNC server on **`localhost:5900`**. While `make e2e`
is running you can attach any VNC client and watch the bot drive the UI:

```bash
# pick whichever VNC client you have:
vncviewer localhost:5900            # tigervnc-viewer
remmina vnc://localhost:5900        # remmina
vinagre localhost:5900              # GNOME's
```

The entrypoint prints `>>> VNC ready — connect to localhost:5900 to watch <<<`
right before WDIO starts, so you have a moment to attach. The session is
unauthenticated (`-nopw`) because the port is only exposed on localhost.

## What it covers

| Spec | Backend surface |
| --- | --- |
| `01-smoke` | App boots, hosts dashboard renders, DB initialises. |
| `02-host-crud` | `save_host` (create + update), `list_hosts`, `delete_host`, modal lifecycle. |
| `03-connect-password` | `ssh_connect` (password), `ssh_send_input`, terminal render, tab close → `ssh_disconnect`. |
| `04-connect-key` | `ssh_connect` via russh-keys (ed25519). |
| `05-persistence` | SQLite DB survives an app restart. |
| `06-error-bad-creds` | Auth-failure path surfaces an error banner in the modal. |
| `07-sftp-flow` | `vault_save_credential` → keychain → Explorer button → `sftp_open` → `sftp_list_dir`. |
| `52-scp-flow` | SFTP→SCP fallback against SFTP-disabled targets, run as a matrix over GNU and busybox userlands: lists, create/delete, and a `scp -t`/`-f` upload+download round-trip. |

## How it's wired together

SSH targets (all on port 2222 inside the compose network):

- **sshd-pass / sshd-key** — linuxserver/openssh, full SFTP. Password and key auth.
- **sshd-scp** — linuxserver/openssh with the SFTP subsystem stripped (GNU
  userland). Forces the SCP fallback; exercises the GNU `find -printf` listing.
- **sshd-scp-busybox** — bare Alpine (busybox only, no GNU coreutils/findutils),
  SFTP stripped. Exercises the busybox `find -exec stat -c` listing path.
  (BSD/macOS — the third listing flavor — can't run as a Linux container, so
  it's covered by `scp/listing.rs` unit tests + manual checks.)

```
┌──────────────────────────┐         ┌───────────────────────────┐
│ sshd-pass                │         │ sshd-key                  │
│ linuxserver/openssh:2222 │         │ linuxserver/openssh:2222  │
│ testuser / testpass      │         │ testuser / ssh key        │
└──────────┬───────────────┘         └───────────┬───────────────┘
           │   sshd-scp (GNU, no SFTP)            │
           │   sshd-scp-busybox (busybox, no SFTP)│
           │       docker compose network        │
           └─────────────────┬───────────────────┘
                             │
                ┌────────────▼────────────┐
                │ e2e (test runner)        │
                │                          │
                │ ┌──────────────────────┐ │
                │ │ pnpm wdio run        │ │
                │ │   ↓ HTTP :4444       │ │
                │ │ tauri-driver         │ │
                │ │   ↓ spawns           │ │
                │ │ WebKitWebDriver      │ │
                │ │   ↓ launches         │ │
                │ │ anyscp (debug build) │ │
                │ │   inside xvfb        │ │
                │ └──────────────────────┘ │
                │                          │
                │ gnome-keyring (unlocked) │
                │ dbus session             │
                └──────────────────────────┘
```

## Per-test isolation

- Every test calls `resetApp()` in `beforeEach`, which wipes
  `$XDG_DATA_HOME/com.macnev2013.anyscp` and calls `browser.reloadSession()`
  to relaunch the Tauri process with a clean SQLite DB.
- The `05-persistence` spec uses `relaunchApp()` instead, which reloads the
  session without wiping the DB.
- The OS keychain (gnome-keyring) is process-scoped inside the runner
  container, so it also resets when the daemon is restarted between full
  `make e2e` invocations.

## Adding a new spec

1. Look up (or add) the relevant `data-testid` in the React component.
   Convention: `<component>-<element>` (e.g. `host-modal-password`).
2. Wrap any new repeated interaction in a helper in `helpers/`.
3. Add a spec under `specs/NN-name.spec.ts`. Specs run in lexical order;
   keep the numeric prefix so failures bisect cleanly.
4. Run `make e2e-shell` and iterate with
   `cd tests/e2e && pnpm exec wdio run wdio.conf.ts --spec ./specs/NN-name.spec.ts`.

## Reading the xterm terminal

`src/components/terminal/Terminal.tsx` registers each `xterm` instance in
`window.__e2eTerminals` keyed by `sessionId`. The helper
`helpers/terminal.ts` reads/writes through that registry so tests don't
have to poke at canvas pixels or DOM rows.

## Build speed / cache

`make e2e` preserves the `rust-target`, `cargo-cache`, and `node-modules`
Docker volumes between runs, so:

- **First run**: full build (~3 min)
- **Same-code rerun**: skips the Tauri build entirely (~30s — the entrypoint
  reuses the existing `anyscp` debug binary)
- **App source changed**: incremental cargo compile against the preserved
  `target/` (typically 5–15s)

If you change Rust source and want to be sure the binary is fresh:

```bash
E2E_FORCE_BUILD=1 make e2e
```

If you need a fully clean slate (volumes wiped, image deleted), use
`make e2e-clean` — but that throws away the cargo crate cache and forces
the next run back to a full build.

## Follow-up: S3 coverage

S3 specs are intentionally deferred — driving them needs:

1. A MinIO sidecar in `docker-compose.yml` (image: `minio/minio:latest`,
   command: `server /data --console-address ":9001"`, fixed root creds).
2. A `keygen`-style one-shot service that creates a bucket and seeds it
   with a couple of test objects.
3. A test helper to add an S3 connection via the UI's `+ New S3` dialog
   pointing at `http://minio:9000` with `path_style: true`.
4. Reusing the existing explorer helpers — the `data-entry-name` / toolbar
   testids work the same for S3 sessions as for SFTP.

The Rust backend (`s3::commands::s3_*`) is the same code path either way,
so the SFTP suite already exercises ~80% of the explorer surface.

## Known caveats

- **First build is slow.** Rust + webkit deps in a fresh image take
  ~5–10 minutes. Subsequent runs reuse `cargo-cache`, `rust-target`, and
  `node-modules` volumes; expect <60s overhead.
- **WebKit DMA-BUF.** The same Wayland-renderer issue that affects
  `pnpm tauri dev` on bare-metal Linux doesn't bite here — we run under
  xvfb (X11), which forces a safe rendering path.
- **`make e2e-clean` blows away the build cache.** Use sparingly; only
  when you've changed `Dockerfile`/`entrypoint.sh` and want a clean rebuild.
- **No Wayland in container.** WebKit runs against xvfb's X11; this mirrors
  CI environments, not your local Wayland session.
