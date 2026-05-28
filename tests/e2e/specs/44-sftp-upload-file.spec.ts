// Upload a local file to the SFTP server via the backend invoke. Verifies
// the uploaded file appears in the remote listing after a refresh.

import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
    deleteEntry,
    refreshExplorer,
    waitForEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";
import { activeSftpSessionId, sftpUpload } from "../helpers/transfers.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";
const REMOTE_HOME = "/config";

describe("SFTP upload file", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("uploads a local file and the entry appears remotely", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "up-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("up-target");

        const hostId = await getHostId("up-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        // Write a small local file.
        const stamp = Date.now();
        const dir = await mkdtemp(join(tmpdir(), "e2e-upload-"));
        const localPath = join(dir, `payload-${stamp}.txt`);
        const remoteName = `uploaded-${stamp}.txt`;
        const remotePath = `${REMOTE_HOME}/${remoteName}`;
        await writeFile(localPath, "hello from e2e upload\n", "utf8");

        const sessionId = await activeSftpSessionId();
        await sftpUpload(sessionId, localPath, remotePath);

        // sftp_upload is async (returns a transfer_id immediately) — poll
        // for the file by refreshing until it shows up.
        await browser.waitUntil(
            async () => {
                await refreshExplorer();
                const el = await $(`[data-entry-name='${remoteName}']`);
                return await el.isExisting();
            },
            { timeout: 15_000, timeoutMsg: `uploaded file '${remoteName}' never appeared` },
        );

        await waitForEntry(remoteName);
        await deleteEntry(remoteName);
    });
});
