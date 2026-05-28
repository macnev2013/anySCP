// SFTP flow: save host (which persists credentials to the keychain),
// open Explorer from the host card, verify the file listing renders.

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

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("SFTP", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("opens an explorer session from the host card", async () => {
        // Add a host. handleSave persists the password to the keychain so
        // the Explorer button can connect non-interactively.
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "sftp-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("sftp-target");

        const hostId = await getHostId("sftp-target");

        // Click the explorer button on the card.
        const explorerBtn = await $(`[data-testid='host-card-${hostId}-explorer']`);
        await explorerBtn.waitForClickable({ timeout: 10_000 });
        await explorerBtn.click();

        // An SFTP tab should appear and the file listing should render.
        await browser.waitUntil(
            async () =>
                (await $("[data-tab-type='sftp']").then((el) => el.isExisting())) === true,
            { timeout: 30_000, timeoutMsg: "SFTP tab never opened" },
        );

        // The Refresh button in the explorer toolbar should be present.
        const refresh = await $("[aria-label='Refresh']");
        await refresh.waitForDisplayed({ timeout: 15_000 });

        // At least one directory entry should render (the linuxserver
        // openssh-server image gives /config as home with a config/ dir).
        await browser.waitUntil(
            async () => (await $$("[data-entry-row='true']")).length > 0,
            { timeout: 15_000, timeoutMsg: "no entries rendered in explorer" },
        );

        const entries = await $$("[data-entry-row='true']");
        expect(entries.length).to.be.greaterThan(0);
    });
});
