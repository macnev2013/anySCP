#!/usr/bin/env bash
# Dedicated synthetic fixtures, published on loopback only. Removes its own
# containers/volumes on completion; never connects to saved app sessions.
set -euo pipefail
cd "$(dirname "$0")/../.."
compose=(docker compose -f tests/quicklook/compose.yml)
trap '"${compose[@]}" down -v >/dev/null 2>&1' EXIT
"${compose[@]}" up -d --build
python3 - <<'PY'
import socket, time
for port in [24222, 24223, 24224, 24900]:
    deadline = time.monotonic() + 60
    while True:
        try:
            with socket.create_connection(('127.0.0.1', port), timeout=1):
                break
        except OSError:
            if time.monotonic() > deadline:
                raise SystemExit(f'Fixture port {port} was not ready after 60 seconds')
            time.sleep(.25)
PY
if [[ ! -f dist/index.html ]]; then pnpm build; fi
cargo test --manifest-path src-tauri/Cargo.toml --lib quicklook_ -- --ignored --nocapture
