// Reconnect-after-disconnect: connect, type `exit` so the remote shell
// closes (which disconnects the SSH session), close the dead tab, then
// reconnect via the card and verify a fresh prompt appears.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    getHostId,
    openHostEdit,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import {
    readTerminalText,
    typeIntoTerminal,
    waitForAnyTerminal,
    waitForTerminalText,
} from "../helpers/terminal.js";
import { cmd } from "../helpers/keyboard.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("reconnect after disconnect", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("can reconnect after the remote shell exits", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "reconnect-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("reconnect-target");

        // First connection.
        const hostId = await getHostId("reconnect-target");
        await openHostEdit("reconnect-target");
        await clickConnect();
        await waitForModalClosed();
        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Send `exit` — the shell closes which tears down the SSH session.
        await typeIntoTerminal(sessionId, "exit\n");
        // Give it a moment for the disconnect signal to propagate.
        await browser.pause(2_000);

        // The terminal buffer should now contain "exit" (the user's keystroke
        // echoed back) or "logout"/"Connection closed" from sshd. Don't
        // require a specific message — just confirm we typed it.
        const buf = await readTerminalText(sessionId);
        if (!buf.includes("exit") && !buf.includes("logout")) {
            throw new Error("did not see exit/logout in terminal buffer");
        }

        // Close the now-disconnected tab.
        await cmd("w");

        // Reconnect via the card (uses stored credentials).
        const explorerBtn = await $(`[data-testid='host-card-${hostId}-terminal']`);
        await explorerBtn.waitForClickable({ timeout: 10_000 });
        await explorerBtn.click();

        const sid2 = await waitForAnyTerminal();
        await waitForTerminalText(sid2, ":~$", { timeoutMs: 20_000 });
    });
});
