// Cmd+T (Ctrl+T on Linux) opens the new-host modal — wired in AppShell's
// useKeyboardShortcuts. Smoke-tests the keyboard plumbing.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import { cmd } from "../helpers/keyboard.js";

describe("keyboard: Cmd+T", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("opens the new-host modal", async () => {
        const modalSel = "[data-testid='host-modal']";
        expect(await (await $(modalSel)).isExisting()).to.equal(false);

        await cmd("t");

        const modal = await $(modalSel);
        await modal.waitForDisplayed({ timeout: 5_000 });
        const mode = await modal.getAttribute("data-host-modal-mode");
        expect(mode).to.equal("new");
    });
});
