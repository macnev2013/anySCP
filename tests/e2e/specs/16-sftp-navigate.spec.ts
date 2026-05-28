// Open SFTP, navigate into a subdirectory, then back via the home button.

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

async function openSftp(): Promise<void> {
    await openNewHostModal();
    await fillPasswordHostForm({
        label: "nav-target",
        host: SSHD_PASS_HOST,
        port: SSHD_PASS_PORT,
        username: SSH_USER,
        password: SSH_PASS,
    });
    await clickSave();
    await waitForModalClosed();
    await findHostCardByLabel("nav-target");

    const hostId = await getHostId("nav-target");
    await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
    await waitForExplorer();
}

describe("SFTP navigate", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("navigates into a subdirectory and back via breadcrumb", async () => {
        await openSftp();

        // We start in the user's home dir (linuxserver/openssh-server uses
        // /config for testuser). Remember the current breadcrumb's last
        // segment so we can navigate back to it.
        const dirName = "e2e-nav-" + Date.now();
        await createFolder(dirName);

        // Navigate into the new subdir.
        await openEntry(dirName);
        await browser.waitUntil(
            async () => {
                const last = await $(`button*=${dirName}`);
                return await last.isExisting();
            },
            { timeout: 5_000, timeoutMsg: "breadcrumb never updated to subdir" },
        );

        // Click the parent segment (second-to-last) to navigate back. The
        // parent's label is the home-dir basename, typically "config".
        await browser.execute((target: string) => {
            const buttons = Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                    "[aria-label='Current path'] button",
                ),
            );
            // The last button is the disabled current dir, the previous one
            // is the parent — click that.
            const parent = buttons.at(-2);
            if (!parent) throw new Error("no parent breadcrumb segment");
            parent.click();
            return target; // unused — just satisfying the API
        }, dirName);

        // The folder we created should be back in the listing.
        const entry = await $(`[data-entry-name='${dirName}']`);
        await entry.waitForExist({ timeout: 5_000 });
        expect(await entry.isExisting()).to.equal(true);

        // Cleanup so a stale folder doesn't accumulate on the test server.
        await deleteEntry(dirName);
    });
});
