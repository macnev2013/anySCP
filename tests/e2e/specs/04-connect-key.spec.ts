// SSH key auth flow. Same as 03 but with the privateKey path.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillKeyHostForm,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";

const SSHD_KEY_HOST = process.env.SSHD_KEY_HOST ?? "sshd-key";
const SSHD_KEY_PORT = Number(process.env.SSHD_KEY_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_KEY_PATH = process.env.SSH_KEY_PATH ?? "/keys/id_ed25519";

describe("connect (key)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("authenticates via an SSH key and opens a terminal", async () => {
        await openNewHostModal();
        await fillKeyHostForm({
            label: "key-target",
            host: SSHD_KEY_HOST,
            port: SSHD_KEY_PORT,
            username: SSH_USER,
            keyPath: SSH_KEY_PATH,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        // The linuxserver/openssh-server image gives a `:~$` prompt with the
        // container hostname (not the username), so wait for the prompt symbol.
        await waitForTerminalText(sessionId, ":~$", { timeoutMs: 20_000 });
    });
});
