// WebdriverIO configuration for anySCP E2E tests.
//
// We spawn `tauri-driver` ourselves (rather than via a service) because
// the wdio service ecosystem doesn't ship an official tauri-driver plugin.
// tauri-driver wraps WebKitWebDriver and proxies sessions to it, launching
// the Tauri binary specified in `tauri:options.application`.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const screenshotDir = path.join(__dirname, "screenshots");
const videoDir = path.join(__dirname, "videos");
const xvfbDisplay = process.env.DISPLAY ?? ":99";

const anyscpBin =
    process.env.ANYSCP_BIN ?? path.join(repoRoot, "src-tauri/target/debug/anyscp");

let driverProcess: ChildProcess | null = null;
let recorder: { proc: ChildProcess; path: string } | null = null;

function startRecording(testTitle: string, parentTitle: string): { proc: ChildProcess; path: string } | null {
    const slug = `${parentTitle}-${testTitle}`
        .replace(/[^a-z0-9-]+/gi, "_")
        .slice(0, 120);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = path.join(videoDir, `${stamp}__${slug}.mp4`);
    // Capture the xvfb display at modest fps. ultrafast preset keeps CPU low
    // (we're sharing the host with the app + tauri-driver + WebKitWebDriver).
    const proc = spawn(
        "ffmpeg",
        [
            "-y",
            "-loglevel", "error",
            "-f", "x11grab",
            "-framerate", "15",
            "-video_size", "1280x800",
            "-i", xvfbDisplay,
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-pix_fmt", "yuv420p",
            out,
        ],
        { stdio: ["ignore", "inherit", "inherit"] },
    );
    return { proc, path: out };
}

async function stopRecording(rec: { proc: ChildProcess; path: string }): Promise<void> {
    return new Promise((resolve) => {
        rec.proc.once("exit", () => resolve());
        // SIGINT lets ffmpeg flush the trailing mp4 atom — SIGTERM would
        // truncate the file and leave it unplayable.
        rec.proc.kill("SIGINT");
        // Hard cap so a misbehaving ffmpeg never blocks teardown.
        setTimeout(() => {
            if (!rec.proc.killed) rec.proc.kill("SIGKILL");
            resolve();
        }, 5_000);
    });
}

export const config: WebdriverIO.Config = {
    runner: "local",
    specs: ["./specs/**/*.spec.ts"],
    maxInstances: 1,

    // tauri-driver speaks the W3C protocol on :4444 by default.
    hostname: "127.0.0.1",
    port: 4444,

    capabilities: [
        {
            // tauri-driver matches on `tauri:options.application` only — it
            // ignores `browserName`, and WebKitWebDriver downstream rejects
            // unknown browserName values with "Failed to match capabilities".
            // @ts-expect-error - tauri:options isn't in WebdriverIO's types
            "tauri:options": {
                application: anyscpBin,
            },
        },
    ],

    logLevel: (process.env.LOG_LEVEL as WebdriverIO.Config["logLevel"]) ?? "info",
    bail: 0,
    waitforTimeout: 15_000,
    connectionRetryTimeout: 60_000,
    connectionRetryCount: 3,

    framework: "mocha",
    reporters: ["spec"],
    mochaOpts: {
        ui: "bdd",
        timeout: 120_000,
    },

    // ── Hooks ─────────────────────────────────────────────────────────────────
    onPrepare() {
        // Start tauri-driver once for the whole suite. It supervises
        // WebKitWebDriver under the hood.
        console.log("[wdio] starting tauri-driver");
        driverProcess = spawn("tauri-driver", [], {
            stdio: ["ignore", "inherit", "inherit"],
        });
        driverProcess.on("error", (err) => {
            console.error("[wdio] tauri-driver failed to start:", err);
        });
        // Give it a moment to bind :4444.
        return new Promise((resolve) => setTimeout(resolve, 1500));
    },

    onComplete() {
        if (driverProcess && !driverProcess.killed) {
            console.log("[wdio] stopping tauri-driver");
            driverProcess.kill("SIGTERM");
        }
    },

    // Each spec gets fresh app state — see helpers/reset.ts.
    beforeTest: async function (test) {
        try {
            await mkdir(videoDir, { recursive: true });
            recorder = startRecording(test.title, String(test.parent ?? ""));
        } catch (err) {
            console.error("[wdio] failed to start video recording:", err);
            recorder = null;
        }
    },

    afterTest: async function (test, _context, result) {
        // Stop the recording first so the mp4 is flushed/closed before we
        // touch it.
        if (recorder) {
            await stopRecording(recorder);
            // Keep ALL recordings (passing + failing) for debugging — the
            // user can delete tests/e2e/videos/ to reclaim disk space.
            console.error(
                `[wdio] ${result.passed ? "PASS" : "FAIL"}: ${test.title}`,
            );
            console.error(`[wdio]   video: ${recorder.path}`);
            recorder = null;
        }

        // On failure, also dump HTML + the URL so we have non-video forensics.
        if (!result.passed) {
            try {
                await mkdir(screenshotDir, { recursive: true });
                const slug = `${test.parent}-${test.title}`
                    .replace(/[^a-z0-9-]+/gi, "_")
                    .slice(0, 120);
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                const htmlPath = path.join(screenshotDir, `${stamp}__${slug}.html`);
                const html = await browser.execute(() => document.documentElement.outerHTML);
                await writeFile(htmlPath, String(html), "utf8");
                const url = await browser.getUrl();
                console.error(`[wdio]   url:       ${url}`);
                console.error(`[wdio]   html dump: ${htmlPath}`);
            } catch (err) {
                console.error("[wdio] failed to capture failure artifacts:", err);
            }
        }
    },
};
