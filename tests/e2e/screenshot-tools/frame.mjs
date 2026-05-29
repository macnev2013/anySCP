// Frame a raw app capture into a polished marketing screenshot:
//   synthesize a macOS-style titlebar (3 traffic lights + "anySCP")
//   → round the window corners → drop shadow → composite onto a
//   violet→blue wallpaper.
//
// Uses `sharp` (one self-contained npm module — bundled libvips, no system
// deps) instead of ImageMagick, so the e2e image stays lean. ffmpeg (already
// in the image) handles the gif separately. Runs under the Node that the
// WDIO harness already uses.
//
// Usage: node frame.mjs <input.png> <output.png>
import sharp from "sharp";

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
    console.error("usage: node frame.mjs <input.png> <output.png>");
    process.exit(1);
}

// ── Tunables ──────────────────────────────────────────────────────────────────
const TITLEBAR_H = 30; // synthesized titlebar height (px)
const RADIUS = 10; // window corner radius (px)
const MARGIN = 52; // wallpaper margin around the window (px)
const MARGIN_BOTTOM = 72; // extra breathing room at the bottom
const PAD = 40; // transparent padding so the shadow isn't clipped
const SHADOW_DY = 12; // shadow vertical offset
const SHADOW_SIGMA = 14; // shadow blur
const BAR_BG = "#1b1b1d";
const TITLE = "anySCP";
const WALL_TOP = "#7c3aed"; // violet
const WALL_BOT = "#1d4ed8"; // blue
const FONT = process.env.FRAME_FONT ?? "DejaVu Sans, sans-serif";

const svg = (s) => Buffer.from(s);

const capture = sharp(inPath);
const { width: W, height: H } = await capture.metadata();
const WH = H + TITLEBAR_H;

// ── 1. Titlebar (traffic lights + title) ────────────────────────────────────
const cy = TITLEBAR_H / 2;
const barSvg = svg(`
<svg width="${W}" height="${TITLEBAR_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${BAR_BG}"/>
  <circle cx="20" cy="${cy}" r="6" fill="#ff5f57"/>
  <circle cx="40" cy="${cy}" r="6" fill="#febc2e"/>
  <circle cx="60" cy="${cy}" r="6" fill="#28c840"/>
  <text x="84" y="${cy + 4}" font-family="${FONT}" font-size="13"
        font-weight="bold" fill="#c7c7cc">${TITLE}</text>
</svg>`);

// ── 2. Window = titlebar stacked above the capture ──────────────────────────
const windowBuf = await sharp({
    create: { width: W, height: WH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
    .composite([
        { input: barSvg, top: 0, left: 0 },
        { input: await capture.toBuffer(), top: TITLEBAR_H, left: 0 },
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

// ── 4. Drop shadow (blurred black rounded rect behind the window) ───────────
const blackRectSvg = svg(
    `<svg width="${W}" height="${WH}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${W}" height="${WH}" rx="${RADIUS}" ry="${RADIUS}" fill="#000"/></svg>`,
);
const shadowRect = await sharp({
    create: { width: W, height: WH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
    .composite([{ input: blackRectSvg }])
    .blur(SHADOW_SIGMA)
    .png()
    .toBuffer();

const SW = W + PAD * 2;
const SH = WH + PAD * 2;
const shadowed = await sharp({
    create: { width: SW, height: SH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
    .composite([
        { input: shadowRect, top: PAD + SHADOW_DY, left: PAD },
        { input: rounded, top: PAD, left: PAD },
    ])
    .png()
    .toBuffer();

// ── 5. Composite onto the wallpaper ─────────────────────────────────────────
const CW = W + MARGIN * 2;
const CH = WH + MARGIN + MARGIN_BOTTOM;
const wallSvg = svg(`
<svg width="${CW}" height="${CH}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${WALL_TOP}"/>
      <stop offset="1" stop-color="${WALL_BOT}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
</svg>`);

await sharp(wallSvg)
    .composite([{ input: shadowed, top: MARGIN - PAD, left: MARGIN - PAD }])
    .png()
    .toFile(outPath);

console.log(`framed: ${outPath} (${CW}x${CH})`);
