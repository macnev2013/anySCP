// Editing a host WITHOUT retyping the password must leave the saved
// credential intact — verified by reconnecting successfully after the edit.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    openHostEdit,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import { cmd } from "../helpers/keyboard.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("vault untouched on edit", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("keeps the saved password when the user edits without retyping it", async () => {
        // Create and Connect (writes credential to vault).
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "untouched",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();
        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Close the terminal and go back to the dashboard.
        await cmd("w");

        // Open the edit modal, change only the label, save.
        await findHostCardByLabel("untouched");
        await openHostEdit("untouched");
        const labelInput = await $("[data-testid='host-modal-label']");
        await labelInput.click();
        await browser.keys(["Control", "a"]);
        await browser.keys(["Backspace"]);
        await labelInput.setValue("untouched-edited");
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("untouched-edited");

        // Reconnect via the card (uses the stored credential — no password
        // in the form). If the vault was overwritten by the empty edit,
        // this would fail with a credential error.
        await openHostEdit("untouched-edited");
        await clickConnect();
        await waitForModalClosed();
        const sid2 = await waitForAnyTerminal();
        await waitForTerminalText(sid2, ":~$", { timeoutMs: 20_000 });
    });
});
