// Issue #90: double-clicking a symlink that points to a directory raised
// "Remote I/O error: Failure: Failure". The lstat-based listing typed the
// symlink as Symlink (not Directory), so handleDoubleClick treated it as a
// file and tried to download a directory. The fix resolves the symlink target
// type during sftp_list_dir, so a symlinked directory is navigable.
//
// We set up a real symlink on the server via the terminal, then drive the
// explorer's double-click and assert we navigate INTO the target.

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
    openEntry,
    refreshExplorer,
    waitForEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";
import { runCommand, waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("Explorer symlinked directory (issue #90)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("double-clicking a symlinked directory navigates into its target", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "symlink-host",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("symlink-host");
        const hostId = await getHostId("symlink-host");

        // 1. Open a terminal and create  ~/symtest/realdir/inside.txt  plus a
        //    symlink  ~/symtest/linkdir -> realdir.  The leading rm makes the
        //    spec idempotent across runs (remote home persists per container).
        await (await $(`[data-testid='host-card-${hostId}-terminal']`)).click();
        const term = await waitForAnyTerminal();
        await waitForTerminalText(term, ":~$");
        const marker = "SYMSETUP_" + Date.now();
        await runCommand(
            term,
            "rm -rf ~/symtest && mkdir -p ~/symtest/realdir && " +
                "echo hi > ~/symtest/realdir/inside.txt && " +
                "ln -s realdir ~/symtest/linkdir && echo " + marker,
            marker,
        );

        // 2. Back to the dashboard, open the SFTP explorer for the same host.
        await (await $("[aria-label='Hosts']")).click();
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        // 3. Navigate into symtest and double-click the symlinked directory.
        await openEntry("symtest");
        await refreshExplorer();
        await waitForEntry("linkdir");
        await openEntry("linkdir"); // double-click

        // 4. We should have navigated into the target — its contents are shown,
        //    and no "Remote I/O error" toast appeared.
        await waitForEntry("inside.txt");
    });
});
