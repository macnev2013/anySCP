// Bad SSH key path — connecting with a non-existent key file should surface
// a clear error in the modal, not hang or crash.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillKeyHostForm,
    openNewHostModal,
} from "../helpers/host.js";

const SSHD_KEY_HOST = process.env.SSHD_KEY_HOST ?? "sshd-key";
const SSHD_KEY_PORT = Number(process.env.SSHD_KEY_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";

describe("bad key path", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("shows an error when the key file does not exist", async () => {
        await openNewHostModal();
        await fillKeyHostForm({
            label: "bad-key",
            host: SSHD_KEY_HOST,
            port: SSHD_KEY_PORT,
            username: SSH_USER,
            keyPath: "/keys/does-not-exist",
        });
        await clickConnect();

        const err = await $("[data-testid='host-modal-error']");
        await err.waitForDisplayed({ timeout: 30_000 });
        const text = await err.getText();
        expect(text.length).to.be.greaterThan(0);

        // Modal stays open so the user can fix the path.
        const modal = await $("[data-testid='host-modal']");
        expect(await modal.isDisplayed()).to.equal(true);
    });
});
