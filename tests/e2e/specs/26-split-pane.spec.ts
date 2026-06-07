// Split-pane: Cmd+D splits the active terminal horizontally; the DOM gets a
// SplitContainer with two TerminalArea children.

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
    runCommand,
    waitForAnyTerminal,
    waitForTerminalText,
} from "../helpers/terminal.js";
import { cmd } from "../helpers/keyboard.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("terminal split pane", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("Cmd+D splits the terminal into two panes", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "split-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();
        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Single pane: no SplitContainer yet.
        expect((await $$("[data-testid='split-container']")).length).to.equal(0);

        await cmd("d");

        // After split, expect one SplitContainer and two terminals.
        await browser.waitUntil(
            async () => (await $$("[data-testid^='terminal-']")).length >= 2,
            { timeout: 10_000, timeoutMsg: "second pane never opened" },
        );
        const split = await $("[data-testid='split-container']");
        await split.waitForExist({ timeout: 5_000 });
        const direction = await split.getAttribute("data-split-direction");
        expect(direction).to.equal("horizontal");
        expect((await $$("[data-testid^='terminal-']")).length).to.equal(2);
    });

    it("preserves the original pane's history across a split", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "split-history",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();
        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Leave a unique marker in the original terminal's scrollback.
        const marker = "split_history_marker_42";
        await runCommand(sessionId, `echo ${marker}`, marker);

        await cmd("d");

        await browser.waitUntil(
            async () => (await $$("[data-testid^='terminal-']")).length >= 2,
            { timeout: 10_000, timeoutMsg: "second pane never opened" },
        );

        // The split remounts the layout (pane -> SplitContainer). The original
        // pane's cached xterm element must be re-parented under the new split
        // and laid out — not left detached as a blank pane. The [data-session-id]
        // node is the Terminal wrapper; the real xterm element is its child.
        await browser.waitUntil(
            async () =>
                browser.execute((sid: string) => {
                    const split = document.querySelector('[data-testid="split-container"]');
                    if (!split) return false;
                    const wrapper = split.querySelector(`[data-session-id="${sid}"]`);
                    if (!wrapper) return false;
                    const xtermEl =
                        (wrapper.querySelector(".xterm") as HTMLElement | null) ??
                        (wrapper.firstElementChild as HTMLElement | null);
                    return !!xtermEl && xtermEl.isConnected && xtermEl.clientHeight > 0;
                }, sessionId),
            {
                timeout: 10_000,
                timeoutMsg: "original pane's xterm element was not re-attached under the split layout",
            },
        );

        // And its scrollback must still hold the pre-split marker.
        await waitForTerminalText(sessionId, marker);
    });
});
