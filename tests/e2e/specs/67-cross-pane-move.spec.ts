// Cross-pane MOVE (dual-pane explorer): the data-loss-prone path. A move
// uploads the local file into the remote pane and deletes the local source —
// but ONLY once the transfer completes. A failed transfer must leave the
// source in place. Both invariants are verified against a live SFTP server.

import { expect } from "chai";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
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
import {
    crossPaneMove,
    enableDualPane,
    paneEntryExists,
    refreshPane,
    waitForBothPanes,
    waitForPaneEntry,
    type CrossPaneEntry,
} from "../helpers/cross-pane.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";
const REMOTE_HOME = "/config";

function fileEntry(path: string): CrossPaneEntry {
    return { id: path, name: basename(path), entryType: "File" };
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function openDualPaneExplorer(label: string): Promise<void> {
    await enableDualPane();
    await openNewHostModal();
    await fillPasswordHostForm({
        label,
        host: SSHD_PASS_HOST,
        port: SSHD_PASS_PORT,
        username: SSH_USER,
        password: SSH_PASS,
    });
    await clickSave();
    await waitForModalClosed();
    await findHostCardByLabel(label);

    const hostId = await getHostId(label);
    await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
    await waitForExplorer();
    await waitForBothPanes("sftp");
}

describe("cross-pane move (local → remote)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("uploads the file remotely and deletes the local source once it lands", async () => {
        await openDualPaneExplorer("xpane-mv");

        const stamp = Date.now();
        const dir = await mkdtemp(join(tmpdir(), "e2e-xpane-mv-"));
        const localPath = join(dir, `moved-${stamp}.txt`);
        await writeFile(localPath, "cross-pane move payload\n", "utf8");

        await crossPaneMove("local", [fileEntry(localPath)], REMOTE_HOME);

        // Lands in the remote pane…
        await waitForPaneEntry("sftp", basename(localPath));
        // …and the source is removed from local disk — but only after the
        // transfer completed, so poll rather than assert immediately.
        await browser.waitUntil(async () => !(await exists(localPath)), {
            timeout: 15_000,
            timeoutMsg: "local source was never deleted after the move completed",
        });
    });

    it("moves several files at once, deleting each source only as it lands", async () => {
        // Multi-file move exercises the id↔entry pairing and the per-id
        // completion tracking (each transfer deletes only its own source).
        await openDualPaneExplorer("xpane-mv-multi");

        const stamp = Date.now();
        const dir = await mkdtemp(join(tmpdir(), "e2e-xpane-mvmulti-"));
        const names = [`m1-${stamp}.txt`, `m2-${stamp}.txt`, `m3-${stamp}.txt`];
        const paths = names.map((n) => join(dir, n));
        for (const p of paths) await writeFile(p, `payload ${basename(p)}\n`, "utf8");

        await crossPaneMove("local", paths.map(fileEntry), REMOTE_HOME);

        // Every file lands remotely…
        for (const n of names) await waitForPaneEntry("sftp", n);
        // …and every local source is gone.
        await browser.waitUntil(
            async () => {
                const present = await Promise.all(paths.map(exists));
                return present.every((p) => !p);
            },
            { timeout: 15_000, timeoutMsg: "not all local sources were deleted after the moves landed" },
        );
    });

    it("leaves the local source in place when the transfer fails", async () => {
        await openDualPaneExplorer("xpane-mv-fail");

        const stamp = Date.now();
        const dir = await mkdtemp(join(tmpdir(), "e2e-xpane-mvfail-"));
        const name = `kept-${stamp}.txt`;
        const localPath = join(dir, name);
        await writeFile(localPath, "must survive a failed move\n", "utf8");

        // Target a remote directory that does not exist → the upload can't land.
        // The "never delete on a non-completed transfer" DECISION is proven
        // deterministically in cross-pane-move.test.ts (both event orderings);
        // this is the integration check that a real failed move loses nothing.
        await crossPaneMove("local", [fileEntry(localPath)], `${REMOTE_HOME}/no-such-dir-${stamp}`);

        // Give the (failing) transfer time to reach its terminal state, then
        // confirm the source survived AND nothing stray landed in the home dir.
        await browser.pause(4_000);
        expect(await exists(localPath)).to.equal(true);
        await refreshPane("sftp");
        expect(await paneEntryExists("sftp", name)).to.equal(false);
    });
});
