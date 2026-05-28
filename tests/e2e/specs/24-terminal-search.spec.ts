// Terminal search: Cmd+F opens the search bar, typing finds matches in
// the active terminal buffer.

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

describe("terminal search", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("Cmd+F finds text in the terminal buffer", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "search-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Emit a unique sentinel into the terminal buffer.
        const sentinel = "findme_" + Date.now();
        await runCommand(sessionId, `echo ${sentinel}`, sentinel);

        // Open search and type the sentinel.
        await cmd("f");
        const input = await $("[data-testid='terminal-search-input']");
        await input.waitForDisplayed({ timeout: 5_000 });
        await input.click();
        await input.setValue(sentinel);

        // The search bar's data-match-text should report a non-empty,
        // non-"No results" hit.
        await browser.waitUntil(
            async () => {
                const txt = await (await $("[data-testid='terminal-search']")).getAttribute(
                    "data-match-text",
                );
                return !!txt && txt !== "No results";
            },
            { timeout: 5_000, timeoutMsg: "search never reported a match" },
        );

        const matchText = await (await $("[data-testid='terminal-search']")).getAttribute(
            "data-match-text",
        );
        expect(matchText).to.match(/of/);
    });
});
