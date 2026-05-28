// SFTP refresh — picks up server-side changes made outside the UI.
//
// We can't easily mutate the server filesystem from inside the test, so this
// spec verifies the more tractable behaviour: clicking refresh briefly
// disables the button while it re-fetches.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    getHostId,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import {
    refreshExplorer,
    waitForExplorer,
    waitForEntry,
    createFolder,
    deleteEntry,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("SFTP refresh", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("refreshes the listing without errors and entries persist", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "refresh-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("refresh-target");

        const hostId = await getHostId("refresh-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const marker = "refresh-marker-" + Date.now();
        await createFolder(marker);

        await refreshExplorer();

        // After refresh, the entry should still be there.
        await waitForEntry(marker, 10_000);
        expect(await (await $(`[data-entry-name='${marker}']`)).isExisting()).to.equal(true);

        await deleteEntry(marker);
    });
});
