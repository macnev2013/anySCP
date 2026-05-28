// Add → edit → delete cycle. Covers save_host (create + update),
// delete_host, list_hosts, and the modal's open/close lifecycle.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { hostCardCount, waitForDashboard } from "../helpers/dashboard.js";
import {
    assertHostAbsent,
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    openHostEdit,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("host CRUD", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("adds a password host and shows it on the dashboard", async () => {
        expect(await hostCardCount()).to.equal(0);

        await openNewHostModal();
        await fillPasswordHostForm({
            label: "alpha",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();

        await findHostCardByLabel("alpha");
        expect(await hostCardCount()).to.equal(1);
    });

    it("edits a host's label", async () => {
        // Seed
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "beta",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("beta");

        await openHostEdit("beta");

        const labelInput = await $("[data-testid='host-modal-label']");
        await labelInput.waitForDisplayed({ timeout: 5_000 });
        await labelInput.setValue("beta-renamed");
        await clickSave();
        await waitForModalClosed();

        await findHostCardByLabel("beta-renamed");
        await assertHostAbsent("beta");
    });

    it("deletes a host from the edit modal", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "gamma",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("gamma");

        await openHostEdit("gamma");

        // Delete → confirm
        const del = await $("[data-testid='host-modal-delete']");
        await del.waitForClickable({ timeout: 5_000 });
        await del.click();
        const confirm = await $("[data-testid='host-modal-delete-confirm']");
        await confirm.waitForClickable({ timeout: 5_000 });
        await confirm.click();

        await waitForModalClosed();
        await assertHostAbsent("gamma");
        expect(await hostCardCount()).to.equal(0);
    });
});
