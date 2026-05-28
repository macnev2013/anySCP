// Error → fix → save: error banner appears on a bad save, disappears once
// the user fixes the form and the save succeeds.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    findHostCardByLabel,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";

describe("error banner clears after a successful save", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("save with empty Host shows an error; filling it in clears the banner", async () => {
        await openNewHostModal();

        // Fill in only Username (Host stays empty — required field).
        const username = await $("[data-testid='host-modal-username']");
        await username.click();
        await username.setValue("testuser");

        await clickSave();

        // Validation error banner should appear, modal stays open.
        const banner = await $("[data-testid='host-modal-error']");
        await banner.waitForDisplayed({ timeout: 5_000 });
        const firstMsg = await banner.getText();
        expect(firstMsg.length).to.be.greaterThan(0);

        // Now fix the form: fill in Host, and Save.
        const host = await $("[data-testid='host-modal-host']");
        await host.click();
        await host.setValue("sshd-pass");

        await clickSave();
        await waitForModalClosed();

        // Modal closed → host saved → no stale banner present.
        // HostCard.displayName is `host.label || host.host` — with no label
        // set, the card shows the bare hostname.
        await findHostCardByLabel("sshd-pass");
        expect(await (await $("[data-testid='host-modal-error']")).isExisting())
            .to.equal(false);
    });
});
