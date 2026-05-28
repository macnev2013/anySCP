// Wrong password should surface as an error in the modal — verifies the
// error banner path through ssh_connect → russh → frontend.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillPasswordHostForm,
    openNewHostModal,
} from "../helpers/host.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";

describe("auth failure", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("shows an error banner when the password is wrong", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "bad-creds",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: "definitely-not-the-password",
        });
        await clickConnect();

        // Modal stays open with the error banner.
        const err = await $("[data-testid='host-modal-error']");
        await err.waitForDisplayed({ timeout: 20_000 });
        const text = await err.getText();
        expect(text.length).to.be.greaterThan(0);

        // Modal should still be visible (i.e. didn't accidentally close).
        const modal = await $("[data-testid='host-modal']");
        expect(await modal.isDisplayed()).to.equal(true);
    });
});
