#!/usr/bin/env bash
# Turn the raw captures (from capture.screens.ts) into the finished marketing
# assets: framed PNGs in screens/ and the demo gif. Runs inside the e2e image
# (ImageMagick + ffmpeg + bundled font) so output is deterministic.
#
# Invoked by `make screenshots` after the capture run, e.g.:
#   docker compose run --rm --no-deps --entrypoint bash e2e \
#       /workspace/tests/e2e/screenshot-tools/build-assets.sh
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../../.." && pwd)
raw="${SCREENSHOT_RAW_DIR:-$here/raw}"
screens="$repo/screens"
videos="$repo/tests/e2e/videos"

mkdir -p "$screens"

# Ensure the harness node_modules (which holds sharp) is resolvable. The
# entrypoint normally symlinks this, but build-assets may run via
# `--entrypoint bash`, which skips the entrypoint.
if [ -d /opt/e2e/node_modules ] && [ ! -e "$repo/tests/e2e/node_modules" ]; then
    ln -sfn /opt/e2e/node_modules "$repo/tests/e2e/node_modules"
fi

# ── 1. Frame each raw capture → screens/<name>.png ──────────────────────────
shopt -s nullglob
framed=0
for src in "$raw"/*.png; do
    name=$(basename "$src" .png)
    echo "[build-assets] framing $name"
    node "$here/frame.mjs" "$src" "$screens/$name.png"
    framed=$((framed + 1))
done
echo "[build-assets] framed $framed screenshot(s)"

# ── 2. Demo gif from the tour test's recording ──────────────────────────────
# The harness writes one mp4 per test as <stamp>__<parent>-<title>.mp4; the
# tour test slugifies to "screenshots-tours_the_app".
tour_mp4=$(ls -t "$videos"/*screenshots-tours_the_app.mp4 2>/dev/null | head -1 || true)
if [[ -z "$tour_mp4" ]]; then
    # Fallback: newest mp4 from this run.
    tour_mp4=$(ls -t "$videos"/*.mp4 2>/dev/null | head -1 || true)
fi

if [[ -n "$tour_mp4" && -f "$tour_mp4" ]]; then
    echo "[build-assets] building gif from $(basename "$tour_mp4")"
    pal=$(mktemp --suffix=.png)
    # Two-pass palette for clean colors. 15fps matches the x11grab capture
    # framerate (smoothest from this source); 1000px wide keeps it crisp but
    # reasonably small.
    ffmpeg -y -loglevel error -i "$tour_mp4" \
        -vf "fps=15,scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff" "$pal"
    ffmpeg -y -loglevel error -i "$tour_mp4" -i "$pal" \
        -lavfi "fps=15,scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer" \
        "$screens/anyscp.gif"
    rm -f "$pal"
    echo "[build-assets] wrote $screens/anyscp.gif"
else
    echo "[build-assets] WARNING: no tour mp4 found in $videos — skipping gif" >&2
fi

echo "[build-assets] done. Assets in $screens"
