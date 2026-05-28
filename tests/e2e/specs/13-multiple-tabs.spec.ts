// Connecting to two hosts produces two terminal tabs alongside the
// permanent Hosts tab.

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
import { tabCountOfType, waitForTabCount } from "../helpers/tabs.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

async function connectFresh(label: string): Promise<void> {
    await openNewHostModal();
    await fillPasswordHostForm({
        label,
        host: SSHD_PASS_HOST,
        port: SSHD_PASS_PORT,
        username: SSH_USER,
        password: SSH_PASS,
    });
    await clickConnect();
    await waitForModalClosed();
}

describe("multiple tabs", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("opens two terminal tabs for two hosts", async () => {
        await connectFresh("first");
        const firstSession = await waitForAnyTerminal();
        await waitForTerminalText(firstSession, ":~$");

        // Switch back to dashboard so the second connect doesn't replace.
        const hostsTab = await $("[data-tab-label='Hosts']");
        await hostsTab.click();

        await connectFresh("second");
        await waitForTabCount(3); // Hosts + 2 terminals

        expect(await tabCountOfType("terminal")).to.equal(2);
    });
});
