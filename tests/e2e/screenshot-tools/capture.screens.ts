// Screenshot capture driver. NOT part of the normal suite — its filename is
// deliberately not `*.spec.ts`, so the `make e2e` glob (specs/**/*.spec.ts)
// skips it. It is run explicitly by `make screenshots`:
//
//   wdio run wdio.conf.ts --spec ./screenshot-tools/capture.screens.ts
//
// It seeds representative data, drives the app to each marketing view, and
// saves the raw WebKit capture to SCREENSHOT_RAW_DIR. A separate framing step
// (frame.sh) then composites those into the finished screens/*.png.
//
// Seeding is representative, not pixel-identical to the hand-made shots — the
// point is screenshots that regenerate and stay current, not a frozen replica.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    getHostId,
    openNewHostModal,
    selectHostGroup,
    waitForModalClosed,
} from "../helpers/host.js";
import { fillGroupAndSave, getGroupId, openNewGroupModal } from "../helpers/groups.js";
import { fillSnippetAndSave, gotoSnippetsPage, openNewSnippetModal } from "../helpers/snippets.js";
import { fillRuleAndSave, gotoPortForwardingPage, openNewRuleDialog } from "../helpers/port-forwards.js";
import { runCommand, typeIntoTerminal, waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import { cmd } from "../helpers/keyboard.js";
import { waitForExplorer } from "../helpers/sftp-ops.js";
import { clickS3Save, fillS3Form, openNewS3Dialog } from "../helpers/s3.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rawDir = process.env.SCREENSHOT_RAW_DIR ?? path.resolve(__dirname, "raw");

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

// S3 connections point at the MinIO sidecar in the e2e stack. Saved (not
// connected), which is enough to render the Cloud Storage cards.
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? "http://minio:9000";
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? "anyscp-test";
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? "minioadmin";
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? "minioadmin";

/** Move the cursor off any nav item to a neutral spot in the page heading
 *  area, so its hover tooltip isn't captured in the screenshot. */
async function moveMouseAway(): Promise<void> {
    try {
        await browser.action("pointer").move({ x: 480, y: 170, duration: 0 }).perform();
        await browser.pause(250); // let the tooltip fade out
    } catch {
        /* pointer actions unsupported — ignore */
    }
}

/** Glide the cursor to an element's centre over ~0.65s so the recorded mouse
 *  movement looks fluid (x11grab captures the cursor). Returns the element. */
async function glide(selector: string): Promise<WebdriverIO.Element> {
    const el = await $(selector);
    await el.waitForClickable({ timeout: 10_000 });
    try {
        const loc = await el.getLocation();
        const size = await el.getSize();
        await browser
            .action("pointer", { parameters: { pointerType: "mouse" } })
            .move({
                origin: "viewport",
                x: Math.round(loc.x + size.width / 2),
                y: Math.round(loc.y + size.height / 2),
                duration: 650,
            })
            .pause(150)
            .perform();
    } catch {
        try {
            await el.moveTo();
        } catch {
            /* pointer actions unsupported — ignore */
        }
    }
    return el;
}

/** Save the current webview to <rawDir>/<name>.png. */
async function snap(name: string, opts: { moveAway?: boolean } = {}): Promise<void> {
    if (opts.moveAway !== false) await moveMouseAway();
    await browser.saveScreenshot(path.join(rawDir, `${name}.png`));
    // eslint-disable-next-line no-console
    console.log(`[capture] saved ${name}.png`);
}

async function addHost(label: string, groupId?: string): Promise<void> {
    await openNewHostModal();
    await fillPasswordHostForm({
        label,
        host: SSHD_PASS_HOST,
        port: SSHD_PASS_PORT,
        username: SSH_USER,
        password: SSH_PASS,
    });
    if (groupId) await selectHostGroup(groupId);
    await clickSave();
    await waitForModalClosed();
}

async function addS3(label: string): Promise<void> {
    await openNewS3Dialog();
    await fillS3Form({
        label,
        provider: "minio",
        accessKey: MINIO_ACCESS_KEY,
        secretKey: MINIO_SECRET_KEY,
        bucket: MINIO_BUCKET,
        endpoint: MINIO_ENDPOINT,
    });
    await clickS3Save();
}

describe("screenshots", () => {
    // Captured on the dashboard in before(); reused later (host ids are stable)
    // so we never call getHostId from a page where host cards aren't mounted.
    let localTestingId = "";
    let databaseId = ""; // reused by the fluid tour (gif)

    before(async function () {
        this.timeout(120_000);
        await mkdir(rawDir, { recursive: true });
        await resetApp();
        await waitForDashboard();

        // Groups + hosts for the dashboard shot.
        await openNewGroupModal();
        await fillGroupAndSave("Production");
        await openNewGroupModal();
        await fillGroupAndSave("Testing");
        // Capture group ids on the dashboard to target the host modal's group
        // option (host-modal-group-option-<id>) deterministically.
        const productionId = await getGroupId("Production");
        const testingId = await getGroupId("Testing");
        await addHost("App", productionId);
        await addHost("Database", productionId);
        await addHost("Local Testing", testingId);

        // Cloud storage (S3) connections — saved against the MinIO sidecar.
        await addS3("Prod Artifacts");
        await addS3("Backups");
        await addS3("Media Assets");

        // Grab the host id now, while host cards are mounted on the dashboard
        // (they don't exist on the Snippets/Tunnels pages).
        localTestingId = await getHostId("Local Testing");

        // Snippets.
        await gotoSnippetsPage();
        await openNewSnippetModal();
        await fillSnippetAndSave({
            name: "Kill process on port",
            command: "kill $(lsof -t -i :{{port}})",
        });
        await openNewSnippetModal();
        await fillSnippetAndSave({
            name: "Process running on a port",
            command: "lsof -i :{{port}}",
        });

        // Tunnels (attached to the host id captured above).
        await gotoPortForwardingPage();
        await openNewRuleDialog();
        await fillRuleAndSave({ label: "Locally Debug App", hostId: localTestingId, localPort: 8080, remotePort: 8080 });
        await openNewRuleDialog();
        await fillRuleAndSave({ label: "Database", hostId: localTestingId, localPort: 27017, remotePort: 27017 });

        // ── Open a few sessions ──────────────────────────────────────────────
        // Populates the dashboard's Recent section and gives the terminal/
        // explorer captures live tabs to shoot (so they don't create sessions).
        await (await $("[aria-label='Hosts']")).click();
        await waitForDashboard();
        const appId = await getHostId("App");
        databaseId = await getHostId("Database");

        // Explorer (SFTP) on Database.
        await (await $(`[data-testid='host-card-${databaseId}-explorer']`)).click();
        await waitForExplorer();

        // Terminal on App — type a few commands. Best-effort: the output is
        // only for the screenshot, so we don't assert on it (passing "" as the
        // expected text means runCommand types + Enters without waiting/flaking).
        await (await $("[aria-label='Hosts']")).click();
        await waitForDashboard();
        await (await $(`[data-testid='host-card-${appId}-terminal']`)).click();
        const termSid = await waitForAnyTerminal();
        await waitForTerminalText(termSid, ":~$", { timeoutMs: 20_000 }).catch(() => {});
        for (const cmd of ["pwd", "whoami", "ls"]) {
            try {
                await runCommand(termSid, cmd, "", 6_000);
            } catch {
                /* best-effort */
            }
        }

        // Terminal on Local Testing — a third recent entry.
        await (await $("[aria-label='Hosts']")).click();
        await waitForDashboard();
        await (await $(`[data-testid='host-card-${localTestingId}-terminal']`)).click();
        await waitForAnyTerminal();
    });

    it("captures the hosts dashboard", async () => {
        await (await $("[aria-label='Hosts']")).click();
        await waitForDashboard();
        await browser.pause(500);
        await snap("hosts");
    });

    it("captures the snippets page", async () => {
        await gotoSnippetsPage();
        await browser.pause(500);
        await snap("snippets");
    });

    it("captures the tunnels page", async () => {
        await gotoPortForwardingPage();
        await browser.pause(500);
        await snap("tunnels");
    });

    it("captures a terminal session", async () => {
        // Switch to the App terminal opened in before() (commands already typed).
        await (await $("[data-tab-type='terminal']")).click();
        await browser.pause(600);
        await snap("terminal");
    });

    it("captures the file explorer with a context menu", async () => {
        // Switch to the Database explorer opened in before().
        await (await $("[data-tab-type='sftp']")).click();
        await waitForExplorer();
        await browser.pause(800);

        // Right-click the first entry to reveal the context menu (best-effort).
        try {
            const firstRow = await $("[data-entry-row='true']");
            await firstRow.waitForExist({ timeout: 8_000 });
            await firstRow.click({ button: "right" });
            await browser.pause(400);
        } catch {
            // No entry / menu — capture the listing as-is.
        }
        // Keep the cursor where the right-click left it so the context menu
        // stays open (don't move the mouse away here).
        await snap("explorer", { moveAway: false });
    });

    // Recorded (one mp4 via the harness's per-test recording) and converted to
    // screens/anyscp.gif by build-assets.sh. Runs last so the terminal + sftp
    // tabs opened above are present to walk through.
    // A fluid product demo — the source for screens/anyscp.gif. The cursor
    // glides between targets, opens the Explorer, opens a Terminal, types a
    // command, and splits the pane (Cmd+D). Recorded as one mp4 by the harness.
    it("tours the app", async function () {
        this.timeout(60_000);

        // 1. Hosts dashboard — let the list settle in view.
        await (await glide("[aria-label='Hosts']")).click();
        await waitForDashboard();
        await browser.pause(1100);

        // 2. Open the file Explorer on a host.
        await (await glide(`[data-testid='host-card-${localTestingId}-explorer']`)).click();
        await waitForExplorer();
        await browser.pause(1600);

        // 3. Back to Hosts, then open a Terminal on another host.
        await (await glide("[aria-label='Hosts']")).click();
        await waitForDashboard();
        await browser.pause(700);
        await (await glide(`[data-testid='host-card-${databaseId}-terminal']`)).click();
        const sid = await waitForAnyTerminal();
        await waitForTerminalText(sid, ":~$", { timeoutMs: 20_000 }).catch(() => {});
        await browser.pause(600);
        await typeIntoTerminal(sid, "ls -la\n");
        await browser.pause(1300);

        // 4. Split the terminal into two panes.
        await cmd("d");
        await browser.pause(900);
        await typeIntoTerminal(sid, "uname -a\n");
        await browser.pause(1800);
    });
});
