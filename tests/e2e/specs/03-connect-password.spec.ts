// Password-auth connect flow. Verifies the full SSH path:
// ssh_connect → terminal mounts → ssh_send_input → output renders → disconnect.

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
    readTerminalText,
    runCommand,
    waitForAnyTerminal,
    waitForTerminalText,
} from "../helpers/terminal.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("connect (password)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("opens a terminal and runs a command", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "pwd-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();

        // The linuxserver/openssh-server image renders a `:~$` prompt with the
        // container hostname, not the username — wait for the prompt symbol.
        await waitForTerminalText(sessionId, ":~$", { timeoutMs: 20_000 });

        // Run a deterministic command. Use a unique sentinel so the
        // assertion can't pass on shell banner text.
        const sentinel = "anyscp_e2e_" + Date.now();
        await runCommand(sessionId, `echo ${sentinel}`, sentinel, 10_000);

        // Sanity: buffer contains both the command echo and the sentinel result.
        const buf = await readTerminalText(sessionId);
        expect(buf).to.include(sentinel);
    });

    it("disconnect via tab close removes the terminal", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "pwd-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();
        await waitForAnyTerminal();

        // Hover the active tab to reveal its close button, then click it.
        const tab = await $("[data-tab-type='terminal']");
        await tab.moveTo();
        const close = await $("[data-tab-type='terminal'] [data-testid$='-close']");
        await close.waitForExist({ timeout: 5_000 });
        await close.click();

        // Terminal element should disappear.
        await browser.waitUntil(
            async () => !(await (await $("[data-testid^='terminal-']")).isExisting()),
            { timeout: 10_000, timeoutMsg: "terminal still present after tab close" },
        );
    });
});
