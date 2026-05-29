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
    clickConnect,
    clickSave,
    fillPasswordHostForm,
    getHostId,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { fillGroupAndSave, openNewGroupModal } from "../helpers/groups.js";
import { fillSnippetAndSave, gotoSnippetsPage, openNewSnippetModal } from "../helpers/snippets.js";
import { fillRuleAndSave, gotoPortForwardingPage, openNewRuleDialog } from "../helpers/port-forwards.js";
import { runCommand, waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
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

/** Save the current webview to <rawDir>/<name>.png. */
async function snap(name: string): Promise<void> {
    await browser.saveScreenshot(path.join(rawDir, `${name}.png`));
    // eslint-disable-next-line no-console
    console.log(`[capture] saved ${name}.png`);
}

async function addHost(label: string): Promise<void> {
    await openNewHostModal();
    await fillPasswordHostForm({
        label,
        host: SSHD_PASS_HOST,
        port: SSHD_PASS_PORT,
        username: SSH_USER,
        password: SSH_PASS,
    });
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
        await addHost("App");
        await addHost("Database");
        await addHost("Local Testing");

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
        // new-host-button only exists on the hosts dashboard; the previous
        // test leaves us on Tunnels, so navigate back first.
        await (await $("[aria-label='Hosts']")).click();
        await waitForDashboard();
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "term",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();
        const sid = await waitForAnyTerminal();
        await waitForTerminalText(sid, ":~$", { timeoutMs: 20_000 });
        await runCommand(sid, "pwd", "/", 8_000);
        await runCommand(sid, "whoami", SSH_USER, 8_000);
        await runCommand(sid, "ls", "", 8_000);
        await browser.pause(500);
        await snap("terminal");
    });

    it("captures the file explorer with a context menu", async () => {
        // The card's explorer button only exists on the hosts dashboard, so
        // navigate there first, then act on the host captured in before().
        await (await $("[aria-label='Hosts']")).click();
        await waitForDashboard();
        const explorerBtn = await $(`[data-testid='host-card-${localTestingId}-explorer']`);
        await explorerBtn.waitForClickable({ timeout: 10_000 });
        await explorerBtn.click();
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
        await snap("explorer");
    });

    // Recorded (one mp4 via the harness's per-test recording) and converted to
    // screens/anyscp.gif by build-assets.sh. Runs last so the terminal + sftp
    // tabs opened above are present to walk through.
    it("tours the app", async () => {
        const stops: Array<[string, string]> = [
            ["Hosts", "[aria-label='Hosts']"],
            ["Snippets", "[aria-label='Snippets']"],
            ["Tunnels", "[aria-label='Tunnels']"],
        ];
        for (const [, sel] of stops) {
            try {
                await (await $(sel)).click();
                await browser.pause(1200);
            } catch {
                /* nav item missing — skip */
            }
        }
        // Walk the open session tabs (terminal, then explorer) for the demo.
        for (const sel of ["[data-tab-type='terminal']", "[data-tab-type='sftp']"]) {
            try {
                const tab = await $(sel);
                if (await tab.isExisting()) {
                    await tab.click();
                    await browser.pause(1500);
                }
            } catch {
                /* tab missing — skip */
            }
        }
    });
});
