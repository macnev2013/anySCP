// Regression for issue #42: after the remote shell exits (`exit`), the
// terminal pane shows the disconnect overlay. Clicking that overlay's Close
// (X) button must remove the tab from the top tab bar — previously the tab was
// left orphaned (a dead host stuck at the top of the GUI with no function that
// only vanished on a full reload), because handleClose pruned the session but
// forgot to remove the unified tab.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillPasswordHostForm,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import {
    typeIntoTerminal,
    waitForAnyTerminal,
    waitForTerminalText,
} from "../helpers/terminal.js";
import { tabCountOfType } from "../helpers/tabs.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("exit then overlay close removes the tab", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("removes the dead terminal tab when the disconnect overlay is closed", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "overlay-close-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");
        expect(await tabCountOfType("terminal")).to.equal(1);

        // Exit the remote shell — the SSH session tears down and the pane shows
        // the disconnect overlay.
        await typeIntoTerminal(sessionId, "exit\n");

        // Click the overlay's Close (X) button once it appears.
        const closeBtn = await $("[aria-label='Close session']");
        await closeBtn.waitForClickable({ timeout: 15_000 });
        await closeBtn.click();

        // The orphaned terminal tab must be gone (issue #42). Before the fix it
        // lingered at the top of the GUI until a full reload.
        await browser.waitUntil(
            async () => (await tabCountOfType("terminal")) === 0,
            {
                timeout: 10_000,
                timeoutMsg: "terminal tab was not removed after closing the disconnect overlay",
            },
        );

        // The app should fall back to the permanent Hosts page tab.
        expect(await tabCountOfType("page")).to.be.at.least(1);
    });
});
