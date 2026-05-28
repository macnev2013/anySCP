// Snippet with {{variables}}: palette opens the variables phase, user fills
// in a value, Run sends the resolved command to the active terminal.

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

describe("snippet variables", () => {
    beforeEach(async () => {
        await resetApp();
    });

    it("prompts for {{var}} and substitutes it into the run command", async () => {
        // Snippet that needs a `name` variable.
        await gotoSnippetsPage();
        await openNewSnippetModal();
        await fillSnippetAndSave({
            name: "Echo Name",
            command: "echo hello {{name}}",
        });

        // Open a terminal.
        const hostsTab = await $("[data-tab-label='Hosts']");
        await hostsTab.click();
        await waitForDashboard();
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "vars-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Open palette, pick the snippet — should switch to the variables phase.
        await cmd("k");
        await waitForSnippetPalette();
        await clickPaletteSnippet("Echo Name");

        // Variable input should appear.
        const varInput = await $("[data-testid='snippet-palette-var-name']");
        await varInput.waitForDisplayed({ timeout: 5_000 });
        const sentinel = "varname_" + Date.now();
        await varInput.click();
        await varInput.setValue(sentinel);

        // Click Run (or press Enter — Run button is the form's submit).
        const run = await $("[data-testid='snippet-palette-run']");
        await run.waitForClickable({ timeout: 5_000 });
        await run.click();

        await waitForTerminalText(sessionId, `hello ${sentinel}`, { timeoutMs: 10_000 });
    });
});
