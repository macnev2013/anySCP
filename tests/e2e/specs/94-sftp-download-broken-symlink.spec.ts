// Issue #128: a broken symlink inside a directory aborted the whole recursive
// SFTP download with "Remote I/O Error: No such file", so files after the link
// were never downloaded. The fix follows symlinks with a stat: links to regular
// files are downloaded, broken links (and links to directories) are skipped.
//
// We build the issue's exact tree on the server via the terminal, download the
// directory through the transfer queue, and assert the job completes with both
// valid files (plus a file reached through a working symlink) on disk.

import { expect } from "chai";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
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
import { waitForExplorer } from "../helpers/sftp-ops.js";
import { runCommand, waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import {
    activeSftpSessionId,
    sftpEnqueueDownload,
    waitForSftpTransferResult,
} from "../helpers/transfers.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";
const REMOTE_HOME = "/config";

describe("SFTP recursive download with a broken symlink (issue #128)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("skips the broken link and downloads every other file", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "broken-link-host",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("broken-link-host");
        const hostId = await getHostId("broken-link-host");

        // 1. Recreate the issue's tree, plus a working symlink to a file:
        //      01-valid.txt
        //      02-broken-link -> /path/that/does/not/exist
        //      03-valid.txt
        //      04-file-link   -> 01-valid.txt
        const dirName = `brokenlink-${Date.now()}`;
        await (await $(`[data-testid='host-card-${hostId}-terminal']`)).click();
        const term = await waitForAnyTerminal();
        await waitForTerminalText(term, ":~$");
        const marker = "BROKENSETUP_" + Date.now();
        await runCommand(
            term,
            `mkdir -p ~/${dirName} && cd ~/${dirName} && ` +
                "echo one > 01-valid.txt && " +
                "ln -s /path/that/does/not/exist 02-broken-link && " +
                "echo three > 03-valid.txt && " +
                "ln -s 01-valid.txt 04-file-link && cd ~ && echo " + marker,
            marker,
        );

        // 2. Open the explorer for the same host and download the directory.
        await (await $("[aria-label='Hosts']")).click();
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const localDir = await mkdtemp(join(tmpdir(), "e2e-broken-link-"));
        const sessionId = await activeSftpSessionId();
        const [transferId] = await sftpEnqueueDownload(
            sessionId,
            [`${REMOTE_HOME}/${dirName}`],
            localDir,
        );

        // 3. The job completes instead of failing on the broken link.
        const result = await waitForSftpTransferResult(transferId);
        expect(result).to.equal("Completed");

        // 4. Valid files (and the file behind the working link) are on disk;
        //    the broken link was skipped.
        const downloaded = join(localDir, dirName);
        const names = (await readdir(downloaded)).sort();
        expect(names).to.deep.equal(["01-valid.txt", "03-valid.txt", "04-file-link"]);
        expect(await readFile(join(downloaded, "01-valid.txt"), "utf8")).to.equal("one\n");
        expect(await readFile(join(downloaded, "03-valid.txt"), "utf8")).to.equal("three\n");
        expect(await readFile(join(downloaded, "04-file-link"), "utf8")).to.equal("one\n");
    });
});
