// Cmd+W closes the active tab (and disconnects the SSH session if it's a
// terminal). The permanent Hosts tab is uncloseable so Cmd+W on it is a
// no-op.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillPasswordHostForm,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import { tabCountOfType } from "../helpers/tabs.js";
import { cmd } from "../helpers/keyboard.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("keyboard: Cmd+W", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("closes the active terminal tab", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "close-target",
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

        await cmd("w");

        await browser.waitUntil(
            async () => (await tabCountOfType("terminal")) === 0,
            { timeout: 10_000, timeoutMsg: "terminal tab did not close on Cmd+W" },
        );
    });
});
