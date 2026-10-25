// Issue #131: PAM / privileged-access gateways disable the SSH `password`
// method and accept the password only via `keyboard-interactive`. anySCP tried
// `password` alone and failed with "server rejected credentials", while PuTTY
// and Termius fell back to keyboard-interactive and connected.
//
// sshd-kbdint (tests/kbdint-server) reproduces that gateway: password auth is
// off, keyboard-interactive (PAM) is on. A saved-password host must connect.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillPasswordHostForm,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { runCommand, waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";

const SSHD_KBDINT_HOST = process.env.SSHD_KBDINT_HOST ?? "sshd-kbdint";
const SSHD_KBDINT_PORT = Number(process.env.SSHD_KBDINT_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("connect via keyboard-interactive (issue #131)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("logs in with a saved password when only keyboard-interactive is allowed", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "kbdint-target",
            host: SSHD_KBDINT_HOST,
            port: SSHD_KBDINT_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$", { timeoutMs: 20_000 });

        // The hostname proves we landed on the keyboard-interactive-only server.
        // The sentinel only appears once the command runs — the prompt already
        // contains the bare hostname, and the echoed input shows `$(hostname)`.
        await runCommand(sessionId, "echo KBDINT_OK_$(hostname)", "KBDINT_OK_anyscp-kbdint", 10_000);
    });

    it("still reports a wrong password instead of hanging", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "kbdint-bad",
            host: SSHD_KBDINT_HOST,
            port: SSHD_KBDINT_PORT,
            username: SSH_USER,
            password: "definitely-wrong",
        });
        await clickConnect();

        // Both methods are tried (keyboard-interactive, then password) and both
        // fail; the modal must surface the error rather than spin forever.
        const err = await $("[data-testid='host-modal-error']");
        await err.waitForDisplayed({ timeout: 30_000 });
        expect((await err.getText()).length).to.be.greaterThan(0);
    });
});
