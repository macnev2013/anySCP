// Host's `startup_command` field is executed by the SSH backend after the
// shell starts. Verify it actually runs by setting it to an echo with a
// known sentinel and asserting the sentinel appears in the terminal.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillPasswordHostForm,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("host startup command", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("runs the host's startup_command after connecting", async () => {
        const sentinel = "startup_marker_" + Date.now();

        await openNewHostModal();
        await fillPasswordHostForm({
            label: "startup-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });

        // Set the startup command via its dedicated testid.
        const startup = await $("[data-testid='host-modal-startup-command']");
        await startup.click();
        await startup.setValue(`echo ${sentinel}`);

        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        // First wait for any prompt so we know we're connected, then look
        // for the startup-command output specifically.
        await waitForTerminalText(sessionId, ":~$");
        await waitForTerminalText(sessionId, sentinel, { timeoutMs: 10_000 });
    });
});
