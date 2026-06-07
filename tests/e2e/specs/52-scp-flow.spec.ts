// SCP fallback flow, run against a matrix of remote userlands. Each target
// has the SFTP subsystem stripped, so opening the Explorer must transparently
// fall back to SCP. The targets cover the Linux listing code paths:
//
//   - GNU            (linuxserver/Alpine + GNU findutils): `find -printf`
//   - busybox        (bare Alpine, no GNU tools):          `find -exec stat -c`
//   - busybox-nostat (busybox with `stat` removed):        `ls -la` (Posix)
//
// busybox-nostat reproduces issue #3 (Buildroot 2020.02.1): with neither
// `find -printf` nor any `stat`, listing must fall through to the universal
// `ls -la` path or the Explorer renders no files.
//
// BSD/macOS (the remaining flavor) can't run as a Linux Docker container, so
// it's covered by unit tests (scp/listing.rs) + manual verification instead.

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

const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

interface Target {
    name: string;
    host: string;
    port: number;
    /** Remote home dir — where the upload/download round-trip writes. */
    home: string;
}

const TARGETS: Target[] = [
    {
        name: "GNU",
        host: process.env.SSHD_SCP_HOST ?? "sshd-scp",
        port: Number(process.env.SSHD_SCP_PORT ?? 2222),
        home: "/config",
    },
    {
        name: "busybox",
        host: process.env.SSHD_SCP_BUSYBOX_HOST ?? "sshd-scp-busybox",
        port: Number(process.env.SSHD_SCP_BUSYBOX_PORT ?? 2222),
        home: "/home/testuser",
    },
    {
        name: "busybox-nostat",
        host: process.env.SSHD_SCP_BUSYBOX_NOSTAT_HOST ?? "sshd-scp-busybox-nostat",
        port: Number(process.env.SSHD_SCP_BUSYBOX_NOSTAT_PORT ?? 2222),
        home: "/home/testuser",
    },
];

for (const target of TARGETS) {
    describe(`SCP fallback (${target.name})`, () => {
        beforeEach(async () => {
            await resetApp();
            await waitForDashboard();
        });

        async function openScpExplorer(label: string): Promise<string> {
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
            return await activeSftpSessionId();
        }

        it("falls back to SCP and lists the remote directory", async () => {
            await openScpExplorer(`scp-${target.name}-list`);

            // Must report SCP transport — proof SFTP failed and we fell back.
            const content = await $("[data-explorer-transport='scp']");
            await content.waitForExist({
                timeout: 15_000,
                timeoutMsg: "explorer did not report SCP transport (fallback failed)",
            });

            // Listing comes from the flavor-specific command over SSH exec.
            await browser.waitUntil(
                async () => (await $$("[data-entry-row='true']")).length > 0,
                { timeout: 15_000, timeoutMsg: "no entries rendered over SCP" },
            );
            expect((await $$("[data-entry-row='true']")).length).to.be.greaterThan(0);
        });

        it("creates and deletes a folder and file over SCP", async () => {
            await openScpExplorer(`scp-${target.name}-fsops`);
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
            const sessionId = await openScpExplorer(`scp-${target.name}-xfer`);

            const stamp = Date.now();
            const payload = `scp-wire-payload-${stamp}\nsecond line\n`;
            const dir = await mkdtemp(join(tmpdir(), "e2e-scp-"));
            const uploadLocal = join(dir, "src.txt");
            const downloadLocal = join(dir, "dst.txt");
            const remoteName = `scp-up-${stamp}.txt`;
            const remotePath = `${target.home}/${remoteName}`;
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
}
