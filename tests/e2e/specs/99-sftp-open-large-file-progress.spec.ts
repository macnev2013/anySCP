// Issue #141: double-clicking a large file to open it in an editor showed
// nothing while the whole file downloaded, and a second double-click opened it
// again. Now a progress toast stays up until the editor launches (it can be
// minimized, never closed), and repeat opens of the same file are ignored.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    getHostId,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { runCommand, waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import { waitForEntry, waitForExplorer } from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

const BIG_FILE = "big-141.log";
// The e2e app is a debug build, so SFTP downloads run at only a few MB/s:
// this is enough to keep the download in flight for the repeat double-click and
// minimize below, without the spec taking minutes on slower CI runners.
const BIG_MB = 80;

async function toastTexts(role: "status" | "alert"): Promise<string[]> {
    return await browser.execute(
        (r: string) =>
            Array.from(document.querySelectorAll(`[role='${r}']`)).map((el) => el.textContent ?? ""),
        role,
    );
}

async function hasToast(role: "status" | "alert", fragment: string): Promise<boolean> {
    return (await toastTexts(role)).some((t) => t.includes(fragment));
}

async function gotoSettingsSection(section: string): Promise<void> {
    const nav = await $("[aria-label='Settings']");
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();
    const sectionNav = await $(`[data-testid='settings-nav-${section}']`);
    await sectionNav.waitForClickable({ timeout: 10_000 });
    await sectionNav.click();
}

describe("SFTP open large file in editor (#141)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("shows progress while downloading and ignores a repeat double-click", async function () {
        // Seeding + downloading a large file runs past the 120 s default on CI.
        this.timeout(240_000);

        // An "editor" that exits immediately — the test is about the download.
        await gotoSettingsSection("editors");
        const addCustom = await $("//button[contains(., 'Add custom editor')]");
        await addCustom.waitForClickable({ timeout: 10_000 });
        await addCustom.click();
        await (await $("[data-testid='ed-name']")).setValue("NoopEditor");
        await (await $("[data-testid='ed-path']")).setValue("/bin/true");
        await (await $("//button[@type='submit' and contains(., 'Add editor')]")).click();
        await (await $("[data-testid='editor-modal']")).waitForExist({ reverse: true, timeout: 5_000 });

        await gotoSettingsSection("explorer");
        const openOpt = await $("[data-testid='s-doubleclick-open']");
        await openOpt.waitForClickable({ timeout: 10_000 });
        await openOpt.click();

        // Seed a large file in the user's home via a terminal on the host.
        await (await $("[aria-label='Hosts']")).click();
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "big-file-host",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("big-file-host");
        const hostId = await getHostId("big-file-host");

        await (await $(`[data-testid='host-card-${hostId}-terminal']`)).click();
        const sessionId = await waitForAnyTerminal(30_000);
        await waitForTerminalText(sessionId, ":~$", { timeoutMs: 30_000 });
        await runCommand(
            sessionId,
            `head -c ${BIG_MB}000000 /dev/zero > ~/${BIG_FILE} && echo SEEDED-141`,
            "SEEDED-141",
            60_000,
        );

        await (await $("[aria-label='Hosts']")).click();
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();
        const entry = await waitForEntry(BIG_FILE, 20_000);

        // First double-click: a progress toast appears and stays up.
        await entry.doubleClick();
        const progressText = `Downloading "${BIG_FILE}" to open…`;
        await browser.waitUntil(() => hasToast("status", progressText), {
            timeout: 10_000,
            timeoutMsg: "no progress toast while the file downloads",
        });

        // Second double-click while it's still downloading: ignored, with a notice.
        await entry.doubleClick();
        await browser.waitUntil(() => hasToast("alert", `"${BIG_FILE}" is already opening…`), {
            timeout: 5_000,
            timeoutMsg: "repeat double-click was not reported as already opening",
        });
        const progressCount = (await toastTexts("status")).filter((t) => t.includes(progressText)).length;
        expect(progressCount, "only one download should be in flight").to.equal(1);

        // It can't be closed — only minimized to a glyph that keeps showing.
        expect(await (await $("[role='status'] button[aria-label='Dismiss']")).isExisting()).to.equal(false);
        await (await $("[role='status'] button[aria-label='Minimize']")).click();
        const glyph = await $("button[data-minimized='true']");
        await glyph.waitForExist({ timeout: 5_000 });
        expect(await hasToast("status", progressText), "minimized glyph keeps the message").to.equal(true);

        // Once downloaded and launched, the progress toast clears with no error.
        await browser.waitUntil(async () => !(await hasToast("status", progressText)), {
            timeout: 150_000,
            interval: 1_000,
            timeoutMsg: "progress toast never cleared",
        });
        const errors = (await toastTexts("alert")).filter((t) => !t.includes("already opening"));
        expect(errors, "opening should not have failed").to.deep.equal([]);
    });
});
