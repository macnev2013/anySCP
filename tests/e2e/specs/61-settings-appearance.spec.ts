// Appearance settings: accent colour, interface/terminal fonts, and the
// active-section memory all persist (or behave) as expected.

import { expect } from "chai";
import { relaunchApp, resetApp } from "../helpers/reset.js";

async function openSettings(): Promise<void> {
    const nav = await $("[aria-label='Settings']");
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();
    await (await $("[data-testid='settings-nav-appearance']")).waitForDisplayed({ timeout: 10_000 });
}

async function openSection(section: string): Promise<void> {
    const tab = await $(`[data-testid='settings-nav-${section}']`);
    await tab.waitForClickable({ timeout: 10_000 });
    await tab.click();
}

/** Open a CustomSelect by trigger test id and pick an option by its value. */
async function pickFromSelect(testid: string, optionValue: string): Promise<void> {
    const trigger = await $(`[data-testid='${testid}']`);
    await trigger.waitForClickable({ timeout: 10_000 });
    await trigger.click();
    // Option value can contain spaces/commas, so quote the attribute selector.
    const option = await $(`[data-testid="${testid}-option-${optionValue}"]`);
    await option.waitForClickable({ timeout: 10_000 });
    await option.click();
}

async function selectedValue(testid: string): Promise<string | null> {
    return (await $(`[data-testid='${testid}']`)).getAttribute("data-value");
}

describe("settings appearance", () => {
    beforeEach(async () => {
        await resetApp();
    });

    it("accent colour preset persists across a restart", async () => {
        await openSettings();

        // Default accent is Blue (hue 250); switch to Orange (hue 70).
        const orange = await $("[data-testid='s-accent-70']");
        await orange.waitForClickable({ timeout: 10_000 });
        await orange.click();
        await browser.waitUntil(
            async () => (await orange.getAttribute("aria-pressed")) === "true",
            { timeout: 5_000, timeoutMsg: "accent swatch did not become selected" },
        );

        await relaunchApp();
        await openSettings();

        const after = await $("[data-testid='s-accent-70']");
        await after.waitForDisplayed({ timeout: 10_000 });
        expect(await after.getAttribute("aria-pressed")).to.equal("true");
    });

    it("interface font persists across a restart", async () => {
        await openSettings();

        await pickFromSelect("s-interface-font", "system-ui, sans-serif");
        await browser.waitUntil(
            async () => (await selectedValue("s-interface-font")) === "system-ui, sans-serif",
            { timeout: 5_000, timeoutMsg: "interface font was not applied" },
        );

        await relaunchApp();
        await openSettings();

        expect(await selectedValue("s-interface-font")).to.equal("system-ui, sans-serif");
    });

    it("terminal font persists across a restart", async () => {
        await openSettings();
        await openSection("terminal");

        await pickFromSelect("s-fontfamily", "monospace");
        await browser.waitUntil(
            async () => (await selectedValue("s-fontfamily")) === "monospace",
            { timeout: 5_000, timeoutMsg: "terminal font was not applied" },
        );

        await relaunchApp();
        await openSettings();
        await openSection("terminal");

        expect(await selectedValue("s-fontfamily")).to.equal("monospace");
    });

    it("remembers the active section when switching away and back", async () => {
        await openSettings();
        await openSection("terminal");
        const termNav = await $("[data-testid='settings-nav-terminal']");
        expect(await termNav.getAttribute("aria-current")).to.equal("page");

        // Switch to another page tab, then back to Settings.
        const hosts = await $("[aria-label='Hosts']");
        await hosts.waitForClickable({ timeout: 10_000 });
        await hosts.click();
        const settings = await $("[aria-label='Settings']");
        await settings.waitForClickable({ timeout: 10_000 });
        await settings.click();

        // The Terminal section should still be active (not reset to Appearance).
        const termNavAfter = await $("[data-testid='settings-nav-terminal']");
        await termNavAfter.waitForDisplayed({ timeout: 10_000 });
        expect(await termNavAfter.getAttribute("aria-current")).to.equal("page");
        expect(await (await $("[data-testid='s-fontsize']")).isDisplayed()).to.equal(true);
    });
});
