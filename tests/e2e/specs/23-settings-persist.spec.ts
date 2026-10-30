// Settings persistence: change a setting, restart the app, verify it persists.

import { expect } from "chai";
import { relaunchApp, resetApp } from "../helpers/reset.js";
import { waitForPersistedSetting } from "../helpers/settings.js";

async function gotoSettings(): Promise<void> {
    const nav = await $("[aria-label='Settings']");
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();
    // The settings page uses a sidebar; open the Terminal section to reach font size.
    const terminalNav = await $("[data-testid='settings-nav-terminal']");
    await terminalNav.waitForClickable({ timeout: 10_000 });
    await terminalNav.click();
    await (await $("[data-testid='s-fontsize']")).waitForDisplayed({ timeout: 10_000 });
}

describe("settings persistence", () => {
    beforeEach(async () => {
        await resetApp();
    });

    it("font size persists across an app restart", async () => {
        await gotoSettings();

        // Font size is a range slider; set its value via the native setter so
        // React's onChange fires (typing/keys don't work on type=range).
        await (await $("[data-testid='s-fontsize']")).waitForDisplayed({ timeout: 10_000 });
        await browser.execute((val) => {
            const node = document.querySelector("[data-testid='s-fontsize']") as HTMLInputElement | null;
            if (!node) throw new Error("Font size slider not found");
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), "value")?.set;
            setter?.call(node, val);
            node.dispatchEvent(new Event("input", { bubbles: true }));
            node.dispatchEvent(new Event("change", { bubbles: true }));
        }, "18");

        // The store persists asynchronously; restarting immediately can kill
        // the app before the IPC write reaches SQLite.
        await waitForPersistedSetting("terminal_font_size", "18");
        await relaunchApp();
        await gotoSettings();

        // The settings page can render defaults before startup hydration ends.
        const after = await $("[data-testid='s-fontsize']");
        await browser.waitUntil(async () => (await after.getValue()) === "18", {
            timeout: 10_000,
            timeoutMsg: "Font size did not reload as 18 after restart",
        });
        expect(await after.getValue()).to.equal("18");
    });
});
