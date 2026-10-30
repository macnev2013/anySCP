# Quick Look verification

Run from the repository root on a machine with Rust, pnpm and Docker:

```sh
pnpm build
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
tests/quicklook/run-adapters.sh
```

The script starts dedicated synthetic services on **127.0.0.1** ports 24222–24224 and 24900, waits for readiness, runs the five opt-in Rust integration tests, and removes its own containers and volumes. These tests never use saved app sessions. The fixed credentials in Compose are public fixture credentials only.

Coverage includes SFTP, GNU/busybox SCP, PNG/PDF/TXT/empty downloads, Unicode names, rejected symlinks/folders/missing/denied/oversized files, 12 successive cancellations followed by a successful transfer on the same SSH connection, cancellation of stalled SFTP/SCP readers, S3 bucket snapshots with identical object keys, and MinIO If-Match enforcement without shared-header mutation. Regular `cargo test` also runs real loopback SSH peers for late channel-open confirmations, stalled metadata and output limits, plus controlled HTTP fixtures for missing/weak ETags, object changes, denied GETs, and cancellation of a stalled S3 body.

Quick Look retains completed downloads within the current app run, per window, keyed by transport, session, full remote path and (for S3) bucket. Every reopen reads fresh remote metadata. A regular local file with the expected size is reused when the remote mtime is no later than its recorded download-start time and its metadata still matches. Unknown mtimes (including SCP's portable `ls` fallback), missing/truncated local files, newer mtimes, changed sizes or S3 ETag/version changes cause a new download. Metadata errors never fall back to a stale preview. This relies on the remote server's timestamps; SSH cannot detect a same-size rewrite that preserves mtime.

Each window keeps at most 32 entries / 512 MiB, evicting least recently used entries. Closing a preview preserves completed files; session/bucket invalidation, window destruction and app exit clear the relevant cache. Files still referenced by the native panel remain pinned until detach. Incomplete downloads retain the existing cancellation/cleanup behavior, and crashed-run cleanup still happens at startup. No cache is restored across app restarts.

Cache regression coverage includes real SFTP/GNU SCP/BusyBox SCP reopens and same-size updates using fixed mtimes, plus controlled S3 HTTP tests verifying HEAD-only cache hits, updated objects, missing/invalid mtimes, missing local files and denied/deleted objects. Unit tests also cover timestamp equality/future values, target isolation, local symlink/truncation rejection, eviction and retaining panel ownership through cache removal.

On a logged-in Mac, the native bridge has a separate probe:

```sh
cargo run --manifest-path src-tauri/Cargo.toml --example quicklook_probe
# Optional synthetic PNG/PDF/media/other fixture, copied into a private tempdir:
cargo run --manifest-path src-tauri/Cargo.toml --example quicklook_probe -- /absolute/path/to/fixture.pdf
```

The probe creates real Tauri windows and checks 20 show/control/Space/Esc/native-close/control-loss/cleanup cycles. Keyboard cases post both key-down and key-up. The close callback promptly dispatches native cleanup from a background thread, matching the manager instead of waiting until after the visibility assertion; this catches repeated close/order-out calls that interfere with Quick Look's asynchronous closing animation. It has no production IPC or connection database. It checks panel lifecycle and preview-item availability, not the visual correctness of rendered contents. Frontend Vitest tests cover selection, shortcuts, delayed progress, owner invalidation and conditional row focus restoration. A complete visual Explorer-to-native acceptance run remains a separate check, including rendered media, third-party preview extensions, focus restoration, and rapid selection, navigation, or session changes.

For a local debug app without release updater signing:

```sh
pnpm tauri build --debug --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

The default packaging configuration also requests release updater signatures and a DMG. This local command does not require a release signing key.
