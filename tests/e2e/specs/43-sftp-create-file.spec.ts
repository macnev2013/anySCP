// Toolbar "New File" creates a zero-byte file with the given name.

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
    createFile,
    deleteEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("SFTP create file", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("creates an empty file via the toolbar", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "cf-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("cf-target");

        const hostId = await getHostId("cf-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const name = "e2e-touched-" + Date.now() + ".txt";
        await createFile(name);
        await deleteEntry(name);
    });
});
