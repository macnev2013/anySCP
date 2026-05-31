// Issue #17: the explorer must keep its current directory when you switch to
// another tab and back, instead of resetting to the home/default dir.

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
import {
    createFolder,
    deleteEntry,
    openEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

async function openSftp(label: string): Promise<void> {
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
    await findHostCardByLabel(label);
    const hostId = await getHostId(label);
    await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
    await waitForExplorer();
}

describe("explorer keeps directory across tab switches", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("stays in the navigated subdirectory after switching tabs and back", async () => {
        await openSftp("keepdir-target");

        // Create a uniquely-named folder and navigate into it.
        const dirName = "e2e-keepdir-" + Date.now();
        await createFolder(dirName);
        await openEntry(dirName);
        await browser.waitUntil(
            async () => (await $(`button*=${dirName}`)).isExisting(),
            { timeout: 5_000, timeoutMsg: "did not enter the subdir" },
        );

        // Switch away to the Hosts page tab, then back to the explorer tab.
        await (await $("[data-tab-type='page']")).click();
        await waitForDashboard();
        await (await $("[data-tab-type='sftp']")).click();
        await waitForExplorer();

        // The explorer must still be inside the subdir — pre-fix it reset to home.
        const crumb = await $(`button*=${dirName}`);
        await crumb.waitForExist({ timeout: 5_000 });
        expect(await crumb.isExisting()).to.equal(true);

        // Cleanup: go to the parent and delete the folder.
        await browser.execute(() => {
            const buttons = Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                    "[aria-label='Current path'] button",
                ),
            );
            buttons.at(-2)?.click();
        });
        await deleteEntry(dirName);
    });
});
