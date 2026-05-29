// Frame a raw app capture into a polished marketing screenshot:
//   synthesize a macOS-style titlebar (3 traffic lights + "anySCP")
//   → round the window corners → composite onto a wallpaper.
//
// Uses `sharp` (one self-contained npm module — bundled libvips, no system
// deps) instead of ImageMagick, so the e2e image stays lean. ffmpeg (already
// in the image) handles the gif separately. Runs under the Node that the
// WDIO harness already uses.
//
// Usage: node frame.mjs <input.png> <output.png>
import sharp from "sharp";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
    console.error("usage: node frame.mjs <input.png> <output.png>");
    process.exit(1);
}

// ── Tunables ──────────────────────────────────────────────────────────────────
const TITLEBAR_H = 38; // synthesized titlebar height (px)
const RADIUS = 12; // window corner radius (px)
const MARGIN = 52; // wallpaper margin around the window (px)
const MARGIN_BOTTOM = 72; // extra breathing room at the bottom
const BAR_BG = "#1b1b1d";
const TITLE = "anySCP";
const WALL_TOP = "#7c3aed"; // violet — gradient fallback
const WALL_BOT = "#1d4ed8"; // blue   — gradient fallback
const FONT = process.env.FRAME_FONT ?? "DejaVu Sans, sans-serif";
// Background photo, cover-cropped behind the window. Override with FRAME_BG;
// falls back to the violet→blue gradient if the file is missing.
const BG_PATH = process.env.FRAME_BG ?? fileURLToPath(new URL("./wallpaper.jpg", import.meta.url));

const svg = (s) => Buffer.from(s);

/** Height of the capture after trimming the empty page background at the
 *  bottom. Short pages (Tunnels, Snippets) leave a large void below their
 *  content; scan the content region (right of the sidebar) bottom-up for the
 *  last non-background row, then keep a little padding. The terminal/explorer
 *  panes use a different dark than the page bg, so they read as content and
 *  are preserved at full height. */
async function trimmedHeight(file) {
    const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;
    const at = (x, y) => {
        const i = (y * width + x) * channels;
        return [data[i], data[i + 1], data[i + 2]];
    };
    const bg = at(Math.floor(width * 0.6), height - 1);
    const THRESH = 14;
    const SIDEBAR = 80; // skip the full-height sidebar
    const PAD_BOTTOM = 28;
    for (let y = height - 1; y >= 0; y--) {
        for (let x = SIDEBAR; x < width; x += 6) {
            const [r, g, b] = at(x, y);
            if (Math.abs(r - bg[0]) > THRESH || Math.abs(g - bg[1]) > THRESH || Math.abs(b - bg[2]) > THRESH) {
                return Math.min(height, y + PAD_BOTTOM);
            }
        }
    }
    return height;
}

const meta = await sharp(inPath).metadata();
const W = meta.width;
// Uniform, full-height windows. Set FRAME_TRIM=1 to instead trim the empty
// page background at the bottom (tighter windows, but variable heights).
const H = process.env.FRAME_TRIM ? await trimmedHeight(inPath) : meta.height;
const captureBuf = await sharp(inPath).extract({ left: 0, top: 0, width: W, height: H }).toBuffer();
const WH = H + TITLEBAR_H;

// Sample the app's own top-edge colour (a couple of px in from the top-centre)
// so the synthesized titlebar blends into the window instead of forming a
// visible second bar.
let barBg = BAR_BG;
try {
    const px = await sharp(inPath)
        .extract({ left: Math.floor(W / 2), top: 2, width: 1, height: 1 })
        .raw()
        .toBuffer();
    barBg = `rgb(${px[0]},${px[1]},${px[2]})`;
} catch {
    /* keep BAR_BG fallback */
}

// ── 1. Titlebar (traffic lights + centred title) ────────────────────────────
const cy = TITLEBAR_H / 2;
const dotR = 6.5;
const barSvg = svg(`
<svg width="${W}" height="${TITLEBAR_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${barBg}"/>
  <circle cx="24" cy="${cy}" r="${dotR}" fill="#ff5f57" stroke="#e0443e" stroke-width="0.5"/>
  <circle cx="46" cy="${cy}" r="${dotR}" fill="#febc2e" stroke="#dea123" stroke-width="0.5"/>
  <circle cx="68" cy="${cy}" r="${dotR}" fill="#28c840" stroke="#1aab29" stroke-width="0.5"/>
  <text x="${W / 2}" y="${cy + 4}" font-family="${FONT}" font-size="13"
        font-weight="600" fill="#9b9ba1" text-anchor="middle"
        letter-spacing="0.2">${TITLE}</text>
</svg>`);

// ── 2. Window = titlebar stacked above the capture ──────────────────────────
const windowBuf = await sharp({
    create: { width: W, height: WH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
    .composite([
        { input: barSvg, top: 0, left: 0 },
        { input: captureBuf, top: TITLEBAR_H, left: 0 },
    ])
    .png()
    .toBuffer();

// ── 3. Rounded corners (mask via dest-in) ───────────────────────────────────
const maskSvg = svg(
    `<svg width="${W}" height="${WH}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${W}" height="${WH}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`,
);
const rounded = await sharp(windowBuf)
    .composite([{ input: maskSvg, blend: "dest-in" }])
    .png()
    .toBuffer();

// ── 4. Composite the rounded window onto the wallpaper (no drop shadow) ──────
const CW = W + MARGIN * 2;
const CH = WH + MARGIN + MARGIN_BOTTOM;

// Background: a bundled photo (cover-cropped to the canvas), or — if absent —
// the violet→blue gradient.
let background;
if (existsSync(BG_PATH)) {
    background = sharp(BG_PATH).resize(CW, CH, { fit: "cover", position: "centre" });
} else {
    background = sharp(
        svg(`
<svg width="${CW}" height="${CH}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${WALL_TOP}"/>
      <stop offset="1" stop-color="${WALL_BOT}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
</svg>`),
    );
}

await background
    .composite([{ input: rounded, top: MARGIN, left: MARGIN }])
    .png()
    .toFile(outPath);

const bgKind = existsSync(BG_PATH) ? "photo" : "gradient";
console.log(`framed: ${outPath} (${CW}x${CH}, ${bgKind} bg)`);
