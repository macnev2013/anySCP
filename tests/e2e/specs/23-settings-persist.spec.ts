// Settings persistence: change a setting, restart the app, verify it persists.

import { expect } from "chai";
import { relaunchApp, resetApp } from "../helpers/reset.js";

async function gotoSettings(): Promise<void> {
    const nav = await $("[aria-label='Settings']");
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();
    await (await $("[data-testid='s-fontsize']")).waitForDisplayed({ timeout: 10_000 });
}

describe("settings persistence", () => {
    beforeEach(async () => {
        await resetApp();
    });

    it("font size persists across an app restart", async () => {
        await gotoSettings();

        const fontInput = await $("[data-testid='s-fontsize']");
        await fontInput.click();
        await browser.keys(["Control", "a"]);
        await browser.keys(["Delete"]);
        await fontInput.setValue("18");
        await browser.keys(["Enter"]);

        await relaunchApp();
        await gotoSettings();

        const after = await $("[data-testid='s-fontsize']");
        expect(await after.getValue()).to.equal("18");
    });
});
