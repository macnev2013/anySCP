// SCP fallback flow. The sshd-scp target has the SFTP subsystem stripped,
// so opening the Explorer must transparently fall back to SCP on the same
// SSH connection. This exercises the full SCP path end-to-end: exec-based
// listing/mkdir/create/delete, plus wire-protocol upload + download.

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
    createFile,
    createFolder,
    deleteEntry,
    refreshExplorer,
    waitForEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";
import { activeSftpSessionId, scpDownload, scpUpload } from "../helpers/transfers.js";

const SSHD_SCP_HOST = process.env.SSHD_SCP_HOST ?? "sshd-scp";
const SSHD_SCP_PORT = Number(process.env.SSHD_SCP_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";
const REMOTE_HOME = "/config";

describe("SCP fallback", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    async function openScpExplorer(label: string): Promise<string> {
        await openNewHostModal();
        await fillPasswordHostForm({
            label,
            host: SSHD_SCP_HOST,
            port: SSHD_SCP_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel(label);

        const hostId = await getHostId(label);
        const explorerBtn = await $(`[data-testid='host-card-${hostId}-explorer']`);
        await explorerBtn.waitForClickable({ timeout: 10_000 });
        await explorerBtn.click();
        await waitForExplorer();
        return await activeSftpSessionId();
    }

    it("falls back to SCP and lists the remote directory", async () => {
        await openScpExplorer("scp-target");

        // The Explorer must report SCP transport — proof the SFTP subsystem
        // failed and we fell back rather than silently using SFTP.
        const content = await $("[data-explorer-transport='scp']");
        await content.waitForExist({
            timeout: 15_000,
            timeoutMsg: "explorer did not report SCP transport (fallback failed)",
        });

        // Listing comes from `find -printf` over SSH exec — must render entries.
        await browser.waitUntil(
            async () => (await $$("[data-entry-row='true']")).length > 0,
            { timeout: 15_000, timeoutMsg: "no entries rendered over SCP" },
        );
        expect((await $$("[data-entry-row='true']")).length).to.be.greaterThan(0);
    });

    it("creates and deletes a folder and file over SCP", async () => {
        await openScpExplorer("scp-fsops");
        const stamp = Date.now();
        const folder = `scp-dir-${stamp}`;
        const file = `scp-file-${stamp}.txt`;

        await createFolder(folder);
        await waitForEntry(folder);
        await createFile(file);
        await waitForEntry(file);

        await deleteEntry(file);
        await deleteEntry(folder);
    });

    it("uploads and downloads a file over the SCP wire protocol", async () => {
        const sessionId = await openScpExplorer("scp-xfer");

        const stamp = Date.now();
        const payload = `scp-wire-payload-${stamp}\nsecond line\n`;
        const dir = await mkdtemp(join(tmpdir(), "e2e-scp-"));
        const uploadLocal = join(dir, "src.txt");
        const downloadLocal = join(dir, "dst.txt");
        const remoteName = `scp-up-${stamp}.txt`;
        const remotePath = `${REMOTE_HOME}/${remoteName}`;
        await writeFile(uploadLocal, payload, "utf8");

        // Upload via `scp -t` wire protocol.
        await scpUpload(sessionId, uploadLocal, remotePath);
        await browser.waitUntil(
            async () => {
                await refreshExplorer();
                return await (await $(`[data-entry-name='${remoteName}']`)).isExisting();
            },
            { timeout: 15_000, timeoutMsg: `uploaded file '${remoteName}' never appeared` },
        );

        // Download it back via `scp -f` and verify byte-for-byte content.
        await scpDownload(sessionId, remotePath, downloadLocal);
        await browser.waitUntil(
            async () => {
                try {
                    return (await readFile(downloadLocal, "utf8")) === payload;
                } catch {
                    return false;
                }
            },
            { timeout: 15_000, timeoutMsg: "downloaded content never matched" },
        );
        expect(await readFile(downloadLocal, "utf8")).to.equal(payload);

        await deleteEntry(remoteName);
    });
});
