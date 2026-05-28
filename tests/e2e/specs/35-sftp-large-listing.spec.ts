// Large listing: create 20 folders, verify they all render, then bulk-delete.
// Catches regressions where the file table breaks (or virtualizes badly)
// when given more than the default "home dir is empty" entry count.

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
    createFolder,
    multiSelectAndDelete,
    waitForEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

const N_ENTRIES = 20;

describe("SFTP large listing", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it(`renders ${N_ENTRIES} entries`, async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "many-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("many-target");

        const hostId = await getHostId("many-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const stamp = Date.now();
        const names = Array.from(
            { length: N_ENTRIES },
            (_, i) => `bulk-${stamp}-${String(i).padStart(2, "0")}`,
        );

        for (const n of names) await createFolder(n);

        // First and last folders both visible in the rendered DOM (sanity:
        // no virtualization is dropping them).
        await waitForEntry(names[0]);
        await waitForEntry(names[names.length - 1]);

        // At minimum the table contains our 20 plus whatever the home dir
        // started with (.ssh, .bash_history, logs, sshd, sshd.pid, ssh_host_keys).
        const total = (await $$("[data-entry-row='true']")).length;
        expect(total).to.be.greaterThanOrEqual(N_ENTRIES);

        await multiSelectAndDelete(names);
    });
});
