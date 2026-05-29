// WebdriverIO configuration for anySCP E2E tests.
//
// We spawn `tauri-driver` ourselves (rather than via a service) because
// the wdio service ecosystem doesn't ship an official tauri-driver plugin.
// tauri-driver wraps WebKitWebDriver and proxies sessions to it, launching
// the Tauri binary specified in `tauri:options.application`.

import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const screenshotDir = path.join(__dirname, "screenshots");
const videoDir = path.join(__dirname, "videos");
const reportPath = path.join(__dirname, "report.md");
const recordsPath = path.join(__dirname, ".test-records.ndjson");
const xvfbDisplay = process.env.DISPLAY ?? ":99";

const anyscpBin =
    process.env.ANYSCP_BIN ?? path.join(repoRoot, "src-tauri/target/debug/anyscp");

let driverProcess: ChildProcess | null = null;
let recorder: { proc: ChildProcess; path: string } | null = null;

interface TestRecord {
    parent: string;
    title: string;
    passed: boolean;
    durationMs: number;
    errorMessage?: string;
    errorStack?: string;
    videoPath?: string;
    htmlDumpPath?: string;
    url?: string;
}

function startRecording(testTitle: string, parentTitle: string): { proc: ChildProcess; path: string } {
    const slug = `${parentTitle}-${testTitle}`
        .replace(/[^a-z0-9-]+/gi, "_")
        .slice(0, 120);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = path.join(videoDir, `${stamp}__${slug}.mp4`);
    const proc = spawn(
        "ffmpeg",
        [
            "-y",
            "-loglevel", "error",
            "-f", "x11grab",
            "-draw_mouse", "0", // hide the cursor — the demo gif shows clicks via ripples instead
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

/**
 * Build a Markdown report from the NDJSON test records written by
 * `afterTest`. Designed to be pasted as-is into a chat or issue.
 */
function renderReport(records: TestRecord[]): string {
    const total = records.length;
    const passed = records.filter((r) => r.passed).length;
    const failed = total - passed;
    const totalMs = records.reduce((s, r) => s + r.durationMs, 0);

    const bySpec = new Map<string, TestRecord[]>();
    for (const r of records) {
        const arr = bySpec.get(r.parent) ?? [];
        arr.push(r);
        bySpec.set(r.parent, arr);
    }

    const lines: string[] = [];
    lines.push(`# anySCP E2E report`);
    lines.push("");
    lines.push(`- **${passed}/${total} passed** (${failed} failed) in ${(totalMs / 1000).toFixed(1)}s`);
    lines.push(`- Generated: ${new Date().toISOString()}`);
    lines.push("");

    // Per-spec summary table.
    lines.push(`## Summary`);
    lines.push("");
    lines.push(`| Spec | Result | Time |`);
    lines.push(`| --- | --- | --- |`);
    for (const [spec, rs] of bySpec) {
        const sPassed = rs.filter((r) => r.passed).length;
        const sTotal = rs.length;
        const sMs = rs.reduce((s, r) => s + r.durationMs, 0);
        const status = sPassed === sTotal ? "✅" : `❌ ${sTotal - sPassed} failed`;
        lines.push(`| ${spec} | ${status} ${sPassed}/${sTotal} | ${(sMs / 1000).toFixed(1)}s |`);
    }
    lines.push("");

    // Per-failure detail.
    const failures = records.filter((r) => !r.passed);
    if (failures.length > 0) {
        lines.push(`## Failures`);
        lines.push("");
        for (const f of failures) {
            lines.push(`### \`${f.parent}\` — ${f.title}`);
            lines.push("");
            if (f.url) lines.push(`- URL: \`${f.url}\``);
            if (f.videoPath) lines.push(`- Video: \`${path.relative(repoRoot, f.videoPath)}\``);
            if (f.htmlDumpPath) lines.push(`- HTML dump: \`${path.relative(repoRoot, f.htmlDumpPath)}\``);
            lines.push(`- Duration: ${(f.durationMs / 1000).toFixed(2)}s`);
            lines.push("");
            if (f.errorMessage) {
                lines.push("```");
                lines.push(f.errorMessage);
                lines.push("```");
                lines.push("");
            }
            if (f.errorStack) {
                lines.push("<details><summary>Stack trace</summary>");
                lines.push("");
                lines.push("```");
                lines.push(f.errorStack);
                lines.push("```");
                lines.push("");
                lines.push("</details>");
                lines.push("");
            }
        }
    }

    // Passing roll-up at the bottom for completeness.
    const passing = records.filter((r) => r.passed);
    if (passing.length > 0) {
        lines.push(`## Passing`);
        lines.push("");
        for (const p of passing) {
            lines.push(`- ✅ \`${p.parent}\` — ${p.title} (${(p.durationMs / 1000).toFixed(2)}s)`);
        }
        lines.push("");
    }

    return lines.join("\n");
}

export const config: WebdriverIO.Config = {
    runner: "local",
    specs: ["./specs/**/*.spec.ts"],
    maxInstances: 1,

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
    async onPrepare() {
        // Truncate the per-run records file before any worker writes to it.
        await rm(recordsPath, { force: true });

        console.log("[wdio] starting tauri-driver");
        driverProcess = spawn("tauri-driver", [], {
            stdio: ["ignore", "inherit", "inherit"],
        });
        driverProcess.on("error", (err) => {
            console.error("[wdio] tauri-driver failed to start:", err);
        });
        return new Promise((resolve) => setTimeout(resolve, 1500));
    },

    async onComplete() {
        if (driverProcess && !driverProcess.killed) {
            console.log("[wdio] stopping tauri-driver");
            driverProcess.kill("SIGTERM");
        }

        // Read the NDJSON records produced by afterTest and write the
        // human-readable Markdown report. Done in the launcher because
        // `afterTest` runs inside worker processes and can't see each other.
        try {
            const raw = await readFile(recordsPath, "utf8").catch(() => "");
            const records: TestRecord[] = raw
                .split("\n")
                .filter((l) => l.trim().length > 0)
                .map((l) => JSON.parse(l) as TestRecord);
            if (records.length > 0) {
                const md = renderReport(records);
                await writeFile(reportPath, md, "utf8");
                console.log(`[wdio] report written: ${reportPath}`);
            } else {
                console.log("[wdio] no test records collected — skipping report");
            }
        } catch (err) {
            console.error("[wdio] failed to write report:", err);
        }
    },

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
        const record: TestRecord = {
            parent: String(test.parent ?? ""),
            title: test.title,
            passed: !!result.passed,
            durationMs: typeof result.duration === "number" ? result.duration : 0,
        };

        if (recorder) {
            await stopRecording(recorder);
            record.videoPath = recorder.path;
            recorder = null;
        }

        if (!result.passed) {
            const errObj = (result as { error?: Error }).error;
            if (errObj) {
                record.errorMessage = errObj.message;
                record.errorStack = errObj.stack;
            }
            try {
                await mkdir(screenshotDir, { recursive: true });
                const slug = `${test.parent}-${test.title}`
                    .replace(/[^a-z0-9-]+/gi, "_")
                    .slice(0, 120);
                const stamp = new Date().toISOString().replace(/[:.]/g, "-");
                const htmlPath = path.join(screenshotDir, `${stamp}__${slug}.html`);
                const html = await browser.execute(() => document.documentElement.outerHTML);
                await writeFile(htmlPath, String(html), "utf8");
                record.htmlDumpPath = htmlPath;
                record.url = await browser.getUrl();
            } catch (err) {
                console.error("[wdio] failed to capture failure artifacts:", err);
            }
        }

        // Append as NDJSON — survives worker crashes mid-run.
        try {
            await appendFile(recordsPath, JSON.stringify(record) + "\n", "utf8");
        } catch (err) {
            console.error("[wdio] failed to append test record:", err);
        }

        console.error(`[wdio] ${record.passed ? "PASS" : "FAIL"}: ${record.title}`);
    },
};
