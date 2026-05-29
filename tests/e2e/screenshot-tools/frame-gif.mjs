// Build the demo gif with the SAME chrome as the screenshots: extract the tour
// recording's frames (cropped to the app window), wrap each in the window
// titlebar + rounded corners + wallpaper via frameCapture(), then reassemble
// into a palette-optimised gif. Reusing frameCapture guarantees the gif's
// background matches screens/*.png exactly.
//
// CLI:  node frame-gif.mjs <in.mp4> <out.gif> [cropW] [cropH] [fps]
//       FRAME_BG=<wallpaper> selects the background (same as frame.mjs).
import sharp from "sharp";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { frameCapture, sampleBarColor } from "./frame.mjs";

const [, , mp4, outGif, cropWArg, cropHArg, fpsArg] = process.argv;
if (!mp4 || !outGif) {
    console.error("usage: node frame-gif.mjs <in.mp4> <out.gif> [cropW] [cropH] [fps]");
    process.exit(1);
}
const cropW = Number(cropWArg) || 1200;
const cropH = Number(cropHArg) || 800;
const fps = Number(fpsArg) || 15;
const GIF_W = 1000; // output gif width (px)

const ff = (args) => execFileSync("ffmpeg", ["-y", "-loglevel", "error", ...args]);

const dir = await mkdtemp(join(tmpdir(), "scp-gif-"));
const rawDir = join(dir, "raw");
const frDir = join(dir, "framed");
await mkdir(rawDir, { recursive: true });
await mkdir(frDir, { recursive: true });

try {
    // 1. Extract frames, cropped to the app window (drops the Xvfb black strip).
    ff(["-i", mp4, "-vf", `fps=${fps},crop=${cropW}:${cropH}:0:0`, join(rawDir, "%04d.png")]);

    const frames = (await readdir(rawDir)).filter((f) => f.endsWith(".png")).sort();
    if (frames.length === 0) throw new Error("no frames extracted from " + mp4);

    // 2. Sample the titlebar colour once (identical across frames) and frame each.
    const barColor = await sampleBarColor(join(rawDir, frames[0]), cropW);
    for (const f of frames) {
        const framed = await frameCapture(join(rawDir, f), { trim: false, barColor });
        await writeFile(join(frDir, f), framed);
    }

    // 3. Reassemble → palette-optimised gif.
    const pal = join(dir, "pal.png");
    const scale = `scale=${GIF_W}:-1:flags=lanczos`;
    ff(["-framerate", String(fps), "-i", join(frDir, "%04d.png"), "-vf", `${scale},palettegen=stats_mode=diff`, pal]);
    ff([
        "-framerate", String(fps),
        "-i", join(frDir, "%04d.png"),
        "-i", pal,
        "-lavfi", `${scale}[x];[x][1:v]paletteuse=dither=bayer`,
        "-loop", "0",
        outGif,
    ]);
    console.log(`gif: ${outGif} (${frames.length} frames @ ${fps}fps, ${GIF_W}px wide)`);
} finally {
    await rm(dir, { recursive: true, force: true });
}
