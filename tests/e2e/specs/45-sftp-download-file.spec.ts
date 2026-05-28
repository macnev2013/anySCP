// Download an SFTP file to a local path and verify its content arrived.
// First upload a known payload so we have something deterministic to
// download back.

import { expect } from "chai";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    waitForExplorer,
} from "../helpers/sftp-ops.js";
import {
    activeSftpSessionId,
    sftpDownload,
    sftpUpload,
} from "../helpers/transfers.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";
const REMOTE_HOME = "/config";

describe("SFTP download file", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("downloads a remote file with matching content", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "dl-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("dl-target");

        const hostId = await getHostId("dl-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const stamp = Date.now();
        const payload = `download-payload-${stamp}\n`;
        const dir = await mkdtemp(join(tmpdir(), "e2e-download-"));
        const uploadLocal = join(dir, "src.txt");
        const downloadLocal = join(dir, "dst.txt");
        const remoteName = `dl-${stamp}.txt`;
        const remotePath = `${REMOTE_HOME}/${remoteName}`;
        await writeFile(uploadLocal, payload, "utf8");

        const sessionId = await activeSftpSessionId();
        await sftpUpload(sessionId, uploadLocal, remotePath);

        await browser.waitUntil(
            async () => {
                await refreshExplorer();
                return await (await $(`[data-entry-name='${remoteName}']`)).isExisting();
            },
            { timeout: 15_000 },
        );

        await sftpDownload(sessionId, remotePath, downloadLocal);

        await browser.waitUntil(
            async () => {
                try {
                    const text = await readFile(downloadLocal, "utf8");
                    return text === payload;
                } catch {
                    return false;
                }
            },
            { timeout: 15_000, timeoutMsg: "downloaded file never matched expected content" },
        );

        const text = await readFile(downloadLocal, "utf8");
        expect(text).to.equal(payload);
        await deleteEntry(remoteName);
    });
});
