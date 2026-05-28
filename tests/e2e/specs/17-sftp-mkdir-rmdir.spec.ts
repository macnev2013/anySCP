// SFTP: create a directory via the toolbar, verify it appears, then delete
// it (Delete key + confirm) and verify it's gone.

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
    waitForExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("SFTP mkdir/rmdir", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("creates a folder via toolbar, then deletes it", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "mkdir-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("mkdir-target");

        const hostId = await getHostId("mkdir-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const folder = "e2e-folder-" + Date.now();
        await createFolder(folder);
        await deleteEntry(folder);
    });
});
