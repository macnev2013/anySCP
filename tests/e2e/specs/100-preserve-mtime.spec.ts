// Issue #160: copying a file stamped it with the time of the copy instead of
// keeping the original modification time (WinSCP keeps it). Uploads now set
// the remote times from the local file (SFTP SETSTAT / scp `T` record) and
// downloads set the local times from the remote file.
//
// Each case uploads a local file dated 2001-09-09, downloads it back to a new
// path and checks the copy still carries that date. The date only survives the
// round trip if both directions preserve it.

import { expect } from "chai";
import { mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
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
import { deleteEntry, refreshExplorer, waitForExplorer } from "../helpers/sftp-ops.js";
import {
    activeSftpSessionId,
    scpDownload,
    scpUpload,
    sftpEnqueueDownload,
    sftpEnqueueUpload,
    waitForSftpTransferResult,
} from "../helpers/transfers.js";

const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

/** 2001-09-09T01:46:40Z — far from "now", so a reset mtime can't pass. */
const OLD_MTIME = 1_000_000_000;

interface Target {
    name: string;
    host: string;
    port: number;
    home: string;
    transport: "sftp" | "scp";
}

const TARGETS: Target[] = [
    {
        name: "SFTP",
        host: process.env.SSHD_PASS_HOST ?? "sshd-pass",
        port: Number(process.env.SSHD_PASS_PORT ?? 2222),
        home: "/config",
        transport: "sftp",
    },
    {
        name: "SCP (GNU)",
        host: process.env.SSHD_SCP_HOST ?? "sshd-scp",
        port: Number(process.env.SSHD_SCP_PORT ?? 2222),
        home: "/config",
        transport: "scp",
    },
    {
        name: "SCP (busybox)",
        host: process.env.SSHD_SCP_BUSYBOX_HOST ?? "sshd-scp-busybox",
        port: Number(process.env.SSHD_SCP_BUSYBOX_PORT ?? 2222),
        home: "/home/testuser",
        transport: "scp",
    },
];

async function mtimeSecs(path: string): Promise<number | null> {
    try {
        return Math.floor((await stat(path)).mtimeMs / 1000);
    } catch {
        return null;
    }
}

for (const target of TARGETS) {
    describe(`Transfers keep the modification time — ${target.name} (issue #160)`, () => {
        beforeEach(async () => {
            await resetApp();
            await waitForDashboard();
        });

        it("upload then download keeps the original date", async () => {
            const label = `mtime-${target.transport}-${target.name.length}`;
            await openNewHostModal();
            await fillPasswordHostForm({
                label,
                host: target.host,
                port: target.port,
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
            await (await $(`[data-explorer-transport='${target.transport}']`)).waitForExist({
                timeout: 15_000,
                timeoutMsg: `explorer did not report ${target.transport} transport`,
            });
            const sessionId = await activeSftpSessionId();

            const stamp = Date.now();
            const dir = await mkdtemp(join(tmpdir(), "e2e-mtime-"));
            const remoteName = `mtime-${stamp}.txt`;
            const remotePath = `${target.home}/${remoteName}`;
            const localSrc = join(dir, remoteName);
            await writeFile(localSrc, "keep my date\n", "utf8");
            await utimes(localSrc, OLD_MTIME, OLD_MTIME);
            expect(await mtimeSecs(localSrc)).to.equal(OLD_MTIME);

            if (target.transport === "sftp") {
                const [up] = await sftpEnqueueUpload(sessionId, [localSrc], target.home);
                expect(await waitForSftpTransferResult(up)).to.equal("Completed");

                const backDir = await mkdtemp(join(tmpdir(), "e2e-mtime-back-"));
                const [down] = await sftpEnqueueDownload(sessionId, [remotePath], backDir);
                expect(await waitForSftpTransferResult(down)).to.equal("Completed");
                expect(await mtimeSecs(join(backDir, remoteName))).to.equal(OLD_MTIME);
            } else {
                // scp_upload / scp_download return before the transfer ends, and
                // the remote entry appears before the sink applies the times, so
                // download into a fresh path until the copy settles.
                await scpUpload(sessionId, localSrc, remotePath);
                await browser.waitUntil(
                    async () => {
                        await refreshExplorer();
                        return await (await $(`[data-entry-name='${remoteName}']`)).isExisting();
                    },
                    { timeout: 15_000, timeoutMsg: `uploaded file '${remoteName}' never appeared` },
                );

                let attempt = 0;
                await browser.waitUntil(
                    async () => {
                        const back = join(dir, `back-${attempt++}.txt`);
                        await scpDownload(sessionId, remotePath, back);
                        await browser.pause(500);
                        return (await mtimeSecs(back)) === OLD_MTIME;
                    },
                    {
                        timeout: 20_000,
                        interval: 250,
                        timeoutMsg: `downloaded copy never had mtime ${OLD_MTIME}`,
                    },
                );
            }

            await deleteEntry(remoteName);
        });
    });
}
