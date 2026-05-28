// Verify that saved hosts survive an app restart — exercises the SQLite
// persistence layer end-to-end.

import { resetApp, relaunchApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("persistence", () => {
    it("saved hosts survive a restart", async () => {
        await resetApp();
        await waitForDashboard();

        await openNewHostModal();
        await fillPasswordHostForm({
            label: "persisted",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("persisted");

        // Relaunch the app without wiping XDG_DATA_HOME.
        await relaunchApp();
        await waitForDashboard();
        await findHostCardByLabel("persisted");
    });
});
