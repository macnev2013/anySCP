// Sidebar collapse: clicking the collapse toggle flips the expanded state.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import { clickCollapseToggle, sidebarExpanded } from "../helpers/sidebar.js";

describe("sidebar collapse", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("toggles the expanded state on click", async () => {
        const initial = await sidebarExpanded();
        await clickCollapseToggle();
        await browser.waitUntil(
            async () => (await sidebarExpanded()) === !initial,
            { timeout: 5_000, timeoutMsg: "sidebar state did not toggle" },
        );
        expect(await sidebarExpanded()).to.equal(!initial);

        // And flips back on a second click.
        await clickCollapseToggle();
        await browser.waitUntil(async () => (await sidebarExpanded()) === initial, {
            timeout: 5_000,
        });
    });
});
