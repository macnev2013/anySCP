// SFTP: rename a folder via F2 key, verify the new name appears and the
// old one is gone.

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
    createFolder,
    deleteEntry,
    renameEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("SFTP rename", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("renames a folder via F2", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "rename-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("rename-target");

        const hostId = await getHostId("rename-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const oldName = "before-" + Date.now();
        const newName = "after-" + Date.now();
        await createFolder(oldName);
        await renameEntry(oldName, newName);

        // Cleanup so subsequent runs don't pile up.
        await deleteEntry(newName);
    });
});
