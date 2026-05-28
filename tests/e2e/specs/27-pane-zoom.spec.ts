// Pane zoom: in a split layout, Cmd+Shift+Enter toggles the zoomed state
// on the active pane.

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
import { cmd, cmdShift } from "../helpers/keyboard.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("terminal pane zoom", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("Cmd+Shift+Enter toggles the zoom state", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "zoom-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();
        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        await cmd("d");
        await browser.waitUntil(
            async () => (await $$("[data-testid^='terminal-']")).length >= 2,
            { timeout: 10_000 },
        );

        const split = await $("[data-testid='split-container']");
        expect(await split.getAttribute("data-zoomed")).to.equal("false");

        await cmdShift("Enter");
        await browser.waitUntil(
            async () => (await split.getAttribute("data-zoomed")) === "true",
            { timeout: 5_000, timeoutMsg: "pane never reported zoomed=true" },
        );

        await cmdShift("Enter");
        await browser.waitUntil(
            async () => (await split.getAttribute("data-zoomed")) === "false",
            { timeout: 5_000, timeoutMsg: "pane never unzoomed" },
        );
    });
});
