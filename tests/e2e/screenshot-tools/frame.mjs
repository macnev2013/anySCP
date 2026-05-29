// Frame a raw app capture into a polished marketing screenshot:
//   synthesize a macOS-style titlebar (3 traffic lights + "anySCP")
//   → round the window corners → composite onto a wallpaper.
//
// Exposes frameCapture() so the gif builder (frame-gif.mjs) wraps every video
// frame in the *exact* same chrome as the screenshots. Uses `sharp` (one
// self-contained npm module — bundled libvips, no system deps).
//
// CLI:  node frame.mjs <input.png> <output.png>
import sharp from "sharp";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── Tunables ──────────────────────────────────────────────────────────────────
export const TITLEBAR_H = 38; // synthesized titlebar height (px)
export const RADIUS = 12; // window corner radius (px)
export const MARGIN = 52; // wallpaper margin around the window (px)
export const MARGIN_BOTTOM = 72; // extra breathing room at the bottom
const BAR_BG = "#1b1b1d";
const TITLE = "anySCP";
const WALL_TOP = "#7c3aed"; // violet — gradient fallback
const WALL_BOT = "#1d4ed8"; // blue   — gradient fallback
const FONT = process.env.FRAME_FONT ?? "DejaVu Sans, sans-serif";
// Background photo, cover-cropped behind the window. Override with FRAME_BG;
// falls back to the violet→blue gradient if the file is missing.
export const BG_PATH = process.env.FRAME_BG ?? fileURLToPath(new URL("./wallpaper.jpg", import.meta.url));

const svg = (s) => Buffer.from(s);

/** Height of the capture after trimming the empty page background at the
 *  bottom. Short pages (Tunnels, Snippets) leave a large void below their
 *  content; scan the content region (right of the sidebar) bottom-up for the
 *  last non-background row, then keep a little padding. The terminal/explorer
 *  panes use a different dark than the page bg, so they read as content and
 *  are preserved at full height. */
async function trimmedHeight(buf) {
    const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
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

/** Sample the app's own top-edge colour (a couple of px in from the
 *  top-centre) so the titlebar blends into the window. */
export async function sampleBarColor(input, width) {
    try {
        const px = await sharp(input)
            .extract({ left: Math.floor(width / 2), top: 2, width: 1, height: 1 })
            .raw()
            .toBuffer();
        return `rgb(${px[0]},${px[1]},${px[2]})`;
    } catch {
        return BAR_BG;
    }
}

/**
 * Wrap a raw app capture in the window chrome + wallpaper.
 * @param {string|Buffer} input        capture (path or PNG buffer)
 * @param {object} [opts]
 * @param {string} [opts.bgPath]       wallpaper path (default BG_PATH)
 * @param {boolean} [opts.trim]        trim empty page bg at the bottom
 * @param {string} [opts.barColor]     pre-sampled titlebar colour (skips per-call sampling)
 * @returns {Promise<Buffer>} framed PNG
 */
export async function frameCapture(input, { bgPath = BG_PATH, trim = false, barColor = null } = {}) {
    const meta = await sharp(input).metadata();
    const W = meta.width;
    const H = trim ? await trimmedHeight(input) : meta.height;
    const captureBuf = await sharp(input).extract({ left: 0, top: 0, width: W, height: H }).toBuffer();
    const WH = H + TITLEBAR_H;

    const barBg = barColor ?? (await sampleBarColor(input, W));

    // 1. Titlebar (traffic lights + centred title).
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

    // 2. Window = titlebar stacked above the capture.
    const windowBuf = await sharp({
        create: { width: W, height: WH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
        .composite([
            { input: barSvg, top: 0, left: 0 },
            { input: captureBuf, top: TITLEBAR_H, left: 0 },
        ])
        .png()
        .toBuffer();

    // 3. Rounded corners (mask via dest-in).
    const maskSvg = svg(
        `<svg width="${W}" height="${WH}" xmlns="http://www.w3.org/2000/svg">` +
            `<rect width="${W}" height="${WH}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`,
    );
    const rounded = await sharp(windowBuf)
        .composite([{ input: maskSvg, blend: "dest-in" }])
        .png()
        .toBuffer();

    // 4. Composite the rounded window onto the wallpaper.
    const CW = W + MARGIN * 2;
    const CH = WH + MARGIN + MARGIN_BOTTOM;
    const background = existsSync(bgPath)
        ? sharp(bgPath).resize(CW, CH, { fit: "cover", position: "centre" })
        : sharp(
              svg(`
<svg width="${CW}" height="${CH}" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${WALL_TOP}"/><stop offset="1" stop-color="${WALL_BOT}"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
</svg>`),
          );

    return background.composite([{ input: rounded, top: MARGIN, left: MARGIN }]).png().toBuffer();
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const [, , inPath, outPath] = process.argv;
    if (!inPath || !outPath) {
        console.error("usage: node frame.mjs <input.png> <output.png>");
        process.exit(1);
    }
    const out = await frameCapture(inPath, { trim: !!process.env.FRAME_TRIM });
    await sharp(out).toFile(outPath);
    const meta = await sharp(out).metadata();
    console.log(`framed: ${outPath} (${meta.width}x${meta.height})`);
}
