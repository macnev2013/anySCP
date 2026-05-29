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
import { cmd, cmdShift } from "../helpers/keyboard.js";
import { refreshExplorer, waitForExplorer } from "../helpers/sftp-ops.js";
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

// The gif recording hides the OS cursor (-draw_mouse 0), so clicks are shown
// with an injected ripple at the click point instead. These helpers run JS in
// the webview to draw the ripple / key badge — they survive React re-renders
// because they live on document.body, outside the React root.

/** Pulse a ripple at an element's centre, click it, then move the (hidden)
 *  pointer off-window so no :hover tooltip lingers in the recording. */
async function rippleClick(selector: string): Promise<void> {
    const el = await $(selector);
    await el.waitForClickable({ timeout: 10_000 });
    await browser.execute((sel: string) => {
        const e = document.querySelector(sel);
        if (!e) return;
        const r = e.getBoundingClientRect();
        if (!document.getElementById("e2e-ripple-style")) {
            const s = document.createElement("style");
            s.id = "e2e-ripple-style";
            s.textContent =
                "@keyframes e2eRipple{0%{transform:translate(-50%,-50%) scale(.5);opacity:.9}" +
                "100%{transform:translate(-50%,-50%) scale(2.6);opacity:0}}";
            document.head.appendChild(s);
        }
        const d = document.createElement("div");
        d.style.cssText =
            `position:fixed;left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;` +
            "width:28px;height:28px;border-radius:50%;background:rgba(96,165,250,.45);" +
            "border:2px solid rgba(147,197,253,.95);pointer-events:none;z-index:2147483647;" +
            "animation:e2eRipple .55s ease-out forwards";
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 650);
    }, selector);
    await browser.pause(220); // let the ripple be seen before the click navigates
    await el.click();
    // Clear hover so no tooltip shows (the cursor itself is hidden in the gif).
    try {
        await browser
            .action("pointer", { parameters: { pointerType: "mouse" } })
            .move({ origin: "viewport", x: 1260, y: 420, duration: 0 })
            .perform();
    } catch {
        /* pointer actions unsupported — ignore */
    }
}

/** Briefly flash a centred key-combo badge (for keyboard actions like split). */
async function keyBadge(text: string): Promise<void> {
    await browser.execute((t: string) => {
        if (!document.getElementById("e2e-badge-style")) {
            const s = document.createElement("style");
            s.id = "e2e-badge-style";
            s.textContent =
                "@keyframes e2eBadge{0%{opacity:0;transform:translate(-50%,-50%) scale(.92)}" +
                "12%{opacity:1;transform:translate(-50%,-50%) scale(1)}80%{opacity:1}100%{opacity:0}}";
            document.head.appendChild(s);
        }
        const d = document.createElement("div");
        d.textContent = t;
        d.style.cssText =
            "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);padding:11px 18px;" +
            "border-radius:12px;background:rgba(18,18,22,.92);color:#e5e7eb;" +
            "font:600 17px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.4px;" +
            "border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 34px rgba(0,0,0,.5);" +
            "pointer-events:none;z-index:2147483647;animation:e2eBadge 1.1s ease forwards";
        document.body.appendChild(d);
        setTimeout(() => d.remove(), 1150);
    }, text);
}

/** Close every closeable tab (the Hosts page tab can't be closed), so the gif
 *  starts from a clean slate. Close buttons are hover-gated; moveTo reveals them. */
async function closeAllTabs(): Promise<void> {
    for (let i = 0; i < 15; i++) {
        const closers = await $$("[data-testid^='tab-'][data-testid$='-close']");
        if (!closers.length) break;
        try {
            await closers[0].moveTo();
            await closers[0].click();
        } catch {
            break;
        }
        await browser.pause(180);
    }
}

/** Current terminal session ids (xterm instances registered by the app). */
async function terminalSids(): Promise<string[]> {
    return (await browser.execute(() => {
        const reg = (window as unknown as { __e2eTerminals?: Map<string, unknown> }).__e2eTerminals;
        return reg ? Array.from(reg.keys()) : [];
    })) as string[];
}

/** Type a command into a terminal character-by-character (so it reads like real
 *  typing in the gif), then run it with Enter. */
async function typeCommand(sid: string, text: string, perChar = 70): Promise<void> {
    for (const ch of text) {
        await typeIntoTerminal(sid, ch);
        await browser.pause(perChar);
    }
    await browser.pause(280);
    await typeIntoTerminal(sid, "\n");
}

// ── Explorer demo helpers ───────────────────────────────────────────────────
// The test-suite sftp-ops helpers are built for speed/reliability: rename
// bypasses the UI via a hook, delete uses the keyboard, create dumps the name
// with setValue. None of that reads in a gif. These variants drive the *real*
// right-click context menu and type slowly so each step is visible.

/** Draw a ripple at an element's centre (the OS cursor is hidden in the gif). */
async function rippleEl(el: WebdriverIO.Element): Promise<void> {
    const rect = await el.getLocation();
    const size = await el.getSize();
    await browser.execute(
        (x: number, y: number) => {
            const d = document.createElement("div");
            d.style.cssText =
                `position:fixed;left:${x}px;top:${y}px;width:24px;height:24px;border-radius:50%;` +
                "background:rgba(96,165,250,.45);border:2px solid rgba(147,197,253,.95);" +
                "pointer-events:none;z-index:2147483647;animation:e2eRipple .55s ease-out forwards";
            document.body.appendChild(d);
            setTimeout(() => d.remove(), 650);
        },
        rect.x + size.width / 2,
        rect.y + size.height / 2,
    );
    await browser.pause(240);
}

/** Type into an input character-by-character so it reads like real typing. */
async function slowTypeInput(el: WebdriverIO.Element, text: string, perChar = 95): Promise<void> {
    for (const ch of text) {
        await el.addValue(ch);
        await browser.pause(perChar);
    }
}

/** Right-click a directory entry and wait for its context menu to open. */
async function openRowMenu(name: string): Promise<void> {
    const row = await $(`[data-entry-name='${name}']`);
    await row.waitForExist({ timeout: 10_000 });
    await row.click({ button: "right" });
    const menu = await $("[role='menu']");
    await menu.waitForDisplayed({ timeout: 5_000 });
    await browser.pause(700); // hold so the menu is clearly visible in the gif
}

/** Ripple + click a context-menu item by its visible label. */
async function clickMenuItem(label: string): Promise<void> {
    const items = await $$("[role='menu'] [role='menuitem']");
    for (const it of items) {
        if ((await it.getText()).trim() === label) {
            await rippleEl(it);
            await it.click();
            return;
        }
    }
    throw new Error(`context-menu item '${label}' not found`);
}

/** Create a file via the toolbar, typing the name slowly. */
async function createFileDemo(name: string): Promise<void> {
    await rippleClick("[data-testid='explorer-new-file']");
    const input = await $("[data-testid='explorer-new-file-input']");
    await input.waitForDisplayed({ timeout: 5_000 });
    await browser.pause(500);
    await slowTypeInput(input, name);
    await browser.pause(500);
    await browser.keys(["Enter"]);
    await (await $(`[data-entry-name='${name}']`)).waitForExist({ timeout: 10_000 });
}

/** Rename an entry through the right-click menu, typing the new name slowly. */
async function renameDemo(oldName: string, newName: string): Promise<void> {
    await openRowMenu(oldName);
    await clickMenuItem("Rename");
    const input = await $("[data-testid='explorer-rename-input']");
    await input.waitForDisplayed({ timeout: 5_000 });
    await browser.pause(400);
    // The input is pre-filled with the old name. A Ctrl+A select-all chord is
    // unreliable in WebKitWebDriver (it appended instead of replacing), so move
    // to the end and backspace each character — also reads nicely in the gif.
    await input.click();
    await browser.keys(["End"]);
    // Backspace past the old name (+ margin; extra backspaces on an empty field
    // are no-ops), so the new name fully replaces it.
    for (let i = 0; i < oldName.length + 2; i++) {
        await browser.keys(["Backspace"]);
        await browser.pause(45);
    }
    await browser.pause(250);
    await slowTypeInput(input, newName);
    await browser.pause(500);
    await browser.keys(["Enter"]);
    await (await $(`[data-entry-name='${newName}']`)).waitForExist({ timeout: 10_000 });
}

/** Delete an entry through the right-click menu + confirm dialog. */
async function deleteDemo(name: string): Promise<void> {
    await openRowMenu(name);
    await clickMenuItem("Delete");
    const confirm = await $("[data-testid='explorer-delete-confirm-button']");
    await confirm.waitForClickable({ timeout: 5_000 });
    await browser.pause(800); // let the confirm dialog register
    await rippleClick("[data-testid='explorer-delete-confirm-button']");
    await browser.waitUntil(
        async () => !(await (await $(`[data-entry-name='${name}']`)).isExisting()),
        { timeout: 10_000, timeoutMsg: `entry '${name}' still present after delete` },
    );
}

/** Run a split shortcut, find the newly-created pane, wait for its prompt, and
 *  type a command into it. `badge` flashes the shortcut on screen. */
async function splitAndType(doSplit: () => Promise<void>, command: string, badge: string): Promise<void> {
    const before = await terminalSids();
    await keyBadge(badge);
    await browser.pause(450);
    await doSplit();
    let newSid: string | undefined;
    await browser.waitUntil(
        async () => {
            newSid = (await terminalSids()).find((s) => !before.includes(s));
            return Boolean(newSid);
        },
        { timeout: 15_000, timeoutMsg: "split pane never appeared" },
    );
    await waitForTerminalText(newSid as string, ":~$", { timeoutMs: 15_000 }).catch(() => {});
    await browser.pause(500);
    await typeCommand(newSid as string, command);
    await browser.pause(900);
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

        // Close every tab HERE — this test's video is discarded, so the tour
        // test that follows starts on a clean Hosts page and its recording (the
        // gif source) never shows tabs being closed.
        await closeAllTabs();
    });

    // Recorded (one mp4 via the harness's per-test recording) and converted to
    // screens/anyscp.gif by build-assets.sh. Runs last so the terminal + sftp
    // tabs opened above are present to walk through.
    // A fluid product demo — the source for screens/anyscp.gif. The cursor
    // glides between targets, opens the Explorer, opens a Terminal, types a
    // command, and splits the pane (Cmd+D). Recorded as one mp4 by the harness.
    it("tours the app", async function () {
        this.timeout(150_000);

        // 0. Tabs were already closed at the end of the previous (explorer)
        //    test — whose video is discarded — so this recording starts clean.
        //    Defensive no-op close in case that didn't run.
        await closeAllTabs();
        await rippleClick("[aria-label='Hosts']");
        await waitForDashboard();
        await browser.pause(900);

        // 1. Connect a terminal and create a file from the shell.
        await rippleClick(`[data-testid='host-card-${databaseId}-terminal']`);
        const sid = await waitForAnyTerminal();
        await waitForTerminalText(sid, ":~$", { timeoutMs: 20_000 }).catch(() => {});
        await browser.pause(500);
        await typeCommand(sid, "touch terminal-test");
        await browser.pause(1100);

        // 2. Split vertically (⌘D, side-by-side) → whoami.
        await splitAndType(() => cmd("d"), "whoami", "⌘ D  ·  Split right");

        // 3. Hosts → open the Explorer on the SAME host (so it shows the file
        //    the terminal just created).
        await rippleClick("[aria-label='Hosts']");
        await waitForDashboard();
        await browser.pause(600);
        await rippleClick(`[data-testid='host-card-${databaseId}-explorer']`);
        await waitForExplorer();
        await browser.pause(1200);

        // 5. Create a file (slow, visible), then rename it via the right-click
        //    menu — both paused enough to read in the gif.
        await createFileDemo("anysp.txt");
        await browser.pause(1300);
        await renameDemo("anysp.txt", "anyscp.txt");
        await browser.pause(1300);

        // 6. Delete the file the terminal created — via the right-click menu so
        //    the context menu + confirm dialog are both on screen.
        await refreshExplorer();
        await browser.pause(700);
        await deleteDemo("terminal-test");
        await browser.pause(1600);
    });
});
