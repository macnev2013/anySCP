// Editing a host's auth type — password → key — must persist and the host
// must reconnect via the new auth method.

import { expect } from "chai";
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

const SSHD_KEY_HOST = process.env.SSHD_KEY_HOST ?? "sshd-key";
const SSHD_KEY_PORT = Number(process.env.SSHD_KEY_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_KEY_PATH = process.env.SSH_KEY_PATH ?? "/keys/id_ed25519";

describe("edit host auth type", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("changes a host from password to key auth and reconnects via key", async () => {
        // Save against sshd-key with a deliberately wrong password — we won't
        // try to connect with it. We'll change to key auth before connecting.
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "switch-target",
            host: SSHD_KEY_HOST,
            port: SSHD_KEY_PORT,
            username: SSH_USER,
            password: "wrong-password-on-purpose",
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("switch-target");

        // Edit — switch auth type to privateKey and set key path.
        await openHostEdit("switch-target");
        const authSel = await $("[data-testid='host-modal-auth']");
        await authSel.click();
        const keyOpt = await $("[data-testid='host-modal-auth-option-privateKey']");
        await keyOpt.waitForClickable({ timeout: 5_000 });
        await keyOpt.click();

        const keyInput = await $("[data-testid='host-modal-keypath']");
        await keyInput.waitForDisplayed({ timeout: 5_000 });
        await keyInput.click();
        await keyInput.setValue(SSH_KEY_PATH);

        await clickSave();
        await waitForModalClosed();

        // Re-open edit modal and confirm the auth type stuck. Read the
        // CustomSelect's `data-value` attribute — more stable than getText()
        // which returns empty for portaled-dropdown buttons in WebKitWebDriver.
        await openHostEdit("switch-target");
        await browser.waitUntil(
            async () =>
                (await (await $("[data-testid='host-modal-auth']")).getAttribute(
                    "data-value",
                )) === "privateKey",
            { timeout: 5_000, timeoutMsg: "auth type did not persist as privateKey" },
        );
        const v = await (await $("[data-testid='host-modal-auth']")).getAttribute("data-value");
        expect(v).to.equal("privateKey");

        // Connect via the now-key auth (the password is wrong; if it tried
        // password auth, this would fail).
        await clickConnect();
        await waitForModalClosed();
        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$", { timeoutMs: 20_000 });

        // Cleanup tab.
        await cmd("w");
    });
});
