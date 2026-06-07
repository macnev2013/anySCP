// SFTP: change a file's Unix permissions via the Properties dialog (chmod).
// Creates a file, applies mode 0o600, and verifies the listing's permission
// column updates to "rw-------".

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
    createFolder,
    deleteEntry,
    entryPermissions,
    navigateUp,
    openEntry,
    setPermissions,
    waitForExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("SFTP properties (chmod)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("changes a file's permissions to 600", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "chmod-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("chmod-target");

        const hostId = await getHostId("chmod-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const name = "perms-" + Date.now() + ".txt";
        await createFile(name);

        // 0o600 = rw------- (owner read/write only).
        await setPermissions(name, 0o600, "rw-------");

        // Cleanup so subsequent runs don't pile up.
        await deleteEntry(name);
    });

    it("changes a directory's permissions recursively", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "chmod-rec",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("chmod-rec");

        const hostId = await getHostId("chmod-rec");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const dir = "recdir-" + Date.now();
        const child = "child.txt";

        // Create the folder, drop a file inside it, then return to the parent
        // (the directory the folder was created in — navigateUp, not root).
        await createFolder(dir);
        await openEntry(dir);
        await createFile(child);
        await navigateUp();

        // 0o700 = rwx------ on both the directory and (recursively) its file.
        await setPermissions(dir, 0o700, "rwx------", true);

        // Verify recursion reached the child.
        await openEntry(dir);
        await browser.waitUntil(
            async () => (await entryPermissions(child)) === "rwx------",
            { timeout: 10_000, timeoutMsg: "child permissions not updated recursively" },
        );

        // Cleanup.
        await navigateUp();
        await deleteEntry(dir);
    });
});
