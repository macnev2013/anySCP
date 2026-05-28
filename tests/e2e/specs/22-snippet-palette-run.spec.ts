// Snippet palette: Cmd+K opens it, selecting a snippet sends its command to
// the active terminal.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillPasswordHostForm,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import {
    clickPaletteSnippet,
    fillSnippetAndSave,
    gotoSnippetsPage,
    openNewSnippetModal,
    waitForSnippetPalette,
} from "../helpers/snippets.js";
import {
    waitForAnyTerminal,
    waitForTerminalText,
} from "../helpers/terminal.js";
import { cmd } from "../helpers/keyboard.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("snippet palette", () => {
    beforeEach(async () => {
        await resetApp();
    });

    it("Cmd+K opens the palette and selecting a snippet sends its command", async () => {
        // Create a snippet first.
        await gotoSnippetsPage();
        await openNewSnippetModal();
        const sentinel = "palette_marker_" + Date.now();
        await fillSnippetAndSave({
            name: "Echo Sentinel",
            command: `echo ${sentinel}`,
        });

        // Open a terminal so the palette has somewhere to send the command.
        const hostsTab = await $("[data-tab-label='Hosts']");
        await hostsTab.click();
        await waitForDashboard();
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "palette-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Open the palette and pick the snippet.
        await cmd("k");
        await waitForSnippetPalette();
        await clickPaletteSnippet("Echo Sentinel");

        await waitForTerminalText(sessionId, sentinel, { timeoutMs: 10_000 });
    });
});
