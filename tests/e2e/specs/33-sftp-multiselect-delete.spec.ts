// Multi-select delete: create 3 folders, select all 3 (via test hook),
// Delete + confirm → all gone in one round-trip.

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
    multiSelectAndDelete,
    waitForExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("SFTP multi-select delete", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("deletes three selected entries in one operation", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "multi-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("multi-target");

        const hostId = await getHostId("multi-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const stamp = Date.now();
        const names = [`m-a-${stamp}`, `m-b-${stamp}`, `m-c-${stamp}`];
        for (const n of names) await createFolder(n);

        await multiSelectAndDelete(names);
    });
});
