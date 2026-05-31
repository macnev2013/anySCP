// SFTP sudo-mode toggle (PR #35): the shield toolbar button reopens the SFTP
// session over `sudo sftp-server` so the user can browse as root, then back.
//
// Infra notes: every e2e sshd target runs `testuser` with SUDO_ACCESS=true
// (passwordless sudo), and the linuxserver/openssh-server image is Alpine, so
// sftp-server lives at /usr/lib/ssh/sftp-server — found via the backend's
// command-v + per-distro probe list. Because testuser != root and the
// transport is sftp, the shield button is rendered.

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
    sudoToggleState,
    toggleSudo,
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

describe("SFTP sudo toggle", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("enables sudo mode then disables it, keeping the listing", async () => {
        await openSftp("sudo-target");

        // The shield button is rendered (non-root sftp session) and starts off.
        const toggle = await $("[data-testid='explorer-sudo-toggle']");
        await toggle.waitForDisplayed({ timeout: 10_000 });
        expect(await sudoToggleState()).to.equal("false");
        expect(await toggle.getAttribute("aria-label")).to.equal("Enable sudo mode");

        // Enable sudo: the session reopens over `sudo sftp-server` as root and
        // the explorer remounts. aria-pressed flips and the listing re-renders.
        await toggleSudo(true);
        expect(await sudoToggleState()).to.equal("true");
        expect(
            await (await $("[data-testid='explorer-sudo-toggle']")).getAttribute("aria-label"),
        ).to.equal("Disable sudo mode");
        await browser.waitUntil(
            async () => (await $$("[data-entry-row='true']")).length > 0,
            { timeout: 15_000, timeoutMsg: "no entries rendered after enabling sudo" },
        );

        // Disable sudo: back to the unprivileged session, symmetrically.
        await toggleSudo(false);
        expect(await sudoToggleState()).to.equal("false");
        expect(
            await (await $("[data-testid='explorer-sudo-toggle']")).getAttribute("aria-label"),
        ).to.equal("Enable sudo mode");
        await browser.waitUntil(
            async () => (await $$("[data-entry-row='true']")).length > 0,
            { timeout: 15_000, timeoutMsg: "no entries rendered after disabling sudo" },
        );
    });

    it("stays in the current directory after toggling sudo", async () => {
        await openSftp("sudo-keepdir");

        // Navigate into a fresh subdir so currentPath is a non-home path.
        const dirName = "e2e-sudo-" + Date.now();
        await createFolder(dirName);
        await openEntry(dirName);
        await browser.waitUntil(
            async () => (await $(`button*=${dirName}`)).isExisting(),
            { timeout: 5_000, timeoutMsg: "did not enter the subdir" },
        );

        // Toggling sudo must reload the SAME directory, not bounce to home/root.
        await toggleSudo(true);
        const crumb = await $(`button*=${dirName}`);
        await crumb.waitForExist({ timeout: 5_000 });
        expect(await crumb.isExisting()).to.equal(true);

        // Cleanup: go up to the parent and delete the folder (as root).
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
