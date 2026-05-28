// Unreachable host — Connect should produce an error banner in the modal
// (mirrors the wrong-password flow but for a transport failure).

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillPasswordHostForm,
    openNewHostModal,
} from "../helpers/host.js";

const SSH_USER = process.env.SSH_USER ?? "testuser";

describe("connect error", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("shows an error banner when the host is unreachable", async () => {
        await openNewHostModal();
        // Port 1 on the runner — guaranteed to be closed; russh should return
        // a connection-refused error within a couple of seconds.
        await fillPasswordHostForm({
            label: "unreachable",
            host: "127.0.0.1",
            port: 1,
            username: SSH_USER,
            password: "anything",
        });
        await clickConnect();

        const err = await $("[data-testid='host-modal-error']");
        await err.waitForDisplayed({ timeout: 30_000 });
        const text = await err.getText();
        expect(text.length).to.be.greaterThan(0);

        // Modal should still be visible — error path leaves the user where they
        // can fix the form and retry.
        const modal = await $("[data-testid='host-modal']");
        expect(await modal.isDisplayed()).to.equal(true);
    });
});
