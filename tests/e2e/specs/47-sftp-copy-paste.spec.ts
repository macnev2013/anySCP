// Copy a remote folder into a subdirectory via the backend copy command.
// Exercises sftp_copy_entries which the UI's Cmd+C/Cmd+V also invokes.

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
    openEntry,
    refreshExplorer,
    waitForEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";
import {
    activeSftpSessionId,
    sftpCopy,
} from "../helpers/transfers.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";
const REMOTE_HOME = "/config";

describe("SFTP copy entries", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("copies a folder into a sibling folder", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "cp-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("cp-target");

        const hostId = await getHostId("cp-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const stamp = Date.now();
        const src = `cp-src-${stamp}`;
        const dest = `cp-dst-${stamp}`;
        await createFolder(src);
        await createFolder(dest);

        const sessionId = await activeSftpSessionId();
        await sftpCopy(sessionId, [`${REMOTE_HOME}/${src}`], `${REMOTE_HOME}/${dest}`);

        // Navigate into destination and verify the copy.
        await openEntry(dest);
        await refreshExplorer();
        await waitForEntry(src);

        // Back to /config and clean up both.
        await browser.execute(() => {
            const buttons = Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                    "[aria-label='Current path'] button",
                ),
            );
            buttons.at(-2)?.click();
        });
        await refreshExplorer();
        await deleteEntry(src);
        await deleteEntry(dest);
    });
});
