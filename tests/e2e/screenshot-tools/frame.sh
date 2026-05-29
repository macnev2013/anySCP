#!/usr/bin/env bash
# Frame a raw app capture into a polished marketing screenshot:
#   synthesize a macOS-style titlebar (3 traffic lights + "anySCP")
#   → round the window corners → drop shadow → composite onto a
#   purple→blue wallpaper.
#
# The raw input is the bare WebKit webview capture (no OS chrome, no
# wallpaper) produced by the capture spec. This step reproduces the look of
# the hand-made screens/*.png.
#
# Deterministic by design: pinned ImageMagick + bundled font in the e2e image
# mean identical bytes on any machine / CI.
#
# Usage: frame.sh <input.png> <output.png>
set -euo pipefail

in=${1:?usage: frame.sh <input.png> <output.png>}
out=${2:?usage: frame.sh <input.png> <output.png>}

# ── Tunables ──────────────────────────────────────────────────────────────────
TITLEBAR_H=30                 # synthesized titlebar height (px)
RADIUS=10                     # window corner radius (px)
MARGIN=52                     # wallpaper margin around the window (px)
MARGIN_BOTTOM=72              # extra breathing room at the bottom
BAR_BG="#1b1b1d"              # titlebar fill (matches the app's dark chrome)
TITLE="anySCP"
TITLE_FG="#c7c7cc"
WALL_TOP="#7c3aed"            # violet
WALL_BOT="#1d4ed8"            # blue
FONT="${FRAME_FONT:-/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf}"

# IM6 uses `convert` + a standalone `identify`; IM7 uses `magick` for both.
if command -v magick >/dev/null 2>&1; then
    IM="magick"
    IDENTIFY="magick identify"
else
    IM="convert"
    IDENTIFY="identify"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Capture dimensions.
W=$($IDENTIFY -format '%w' "$in")
H=$($IDENTIFY -format '%h' "$in")

# ── 1. Titlebar (traffic lights + title) ────────────────────────────────────
#   Dots: red / yellow / green, 12px, vertically centred.
cy=$((TITLEBAR_H / 2))
$IM -size "${W}x${TITLEBAR_H}" "xc:${BAR_BG}" \
    -fill "#ff5f57" -draw "circle 20,${cy} 20,$((cy-6))" \
    -fill "#febc2e" -draw "circle 40,${cy} 40,$((cy-6))" \
    -fill "#28c840" -draw "circle 60,${cy} 60,$((cy-6))" \
    -font "$FONT" -pointsize 13 -fill "$TITLE_FG" \
    -gravity West -annotate +84+0 "$TITLE" \
    "$tmp/bar.png"

# ── 2. Window = titlebar stacked above the capture ──────────────────────────
$IM "$tmp/bar.png" "$in" -append "$tmp/window.png"
WH=$((H + TITLEBAR_H))

# ── 3. Rounded corners (DstIn mask) ─────────────────────────────────────────
$IM -size "${W}x${WH}" xc:none \
    -draw "roundrectangle 0,0,$((W-1)),$((WH-1)),${RADIUS},${RADIUS}" \
    "$tmp/mask.png"
$IM "$tmp/window.png" "$tmp/mask.png" -alpha set -compose DstIn -composite \
    "$tmp/rounded.png"

# ── 4. Drop shadow ──────────────────────────────────────────────────────────
$IM "$tmp/rounded.png" \
    \( +clone -background black -shadow 55x16+0+12 \) \
    +swap -background none -layers merge +repage \
    "$tmp/shadow.png"

# ── 5. Composite onto the wallpaper ─────────────────────────────────────────
SW=$($IDENTIFY -format '%w' "$tmp/shadow.png")
SH=$($IDENTIFY -format '%h' "$tmp/shadow.png")
CW=$((SW + MARGIN * 2))
CH=$((SH + MARGIN + MARGIN_BOTTOM))

# Linear violet→blue gradient, nudged diagonally to echo the original.
$IM -size "${CH}x${CW}" "gradient:${WALL_TOP}-${WALL_BOT}" -rotate 90 \
    -resize "${CW}x${CH}!" "$tmp/wall.png"

$IM "$tmp/wall.png" "$tmp/shadow.png" -gravity North -geometry "+0+${MARGIN}" \
    -composite "$out"

echo "framed: $out (${CW}x${CH})"
