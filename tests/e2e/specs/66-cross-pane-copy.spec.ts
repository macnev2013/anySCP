// Cross-pane COPY (dual-pane explorer): copying a local file into the remote
// pane uploads it there and leaves the local source untouched. Exercises the
// ExplorerPage transfer coordinator end-to-end against a live SFTP server —
// the path the UI's "Copy to <sibling>" / Cmd+C+Cmd+V also drives.

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
    crossPaneCopy,
    enableDualPane,
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

describe("cross-pane copy (local → remote)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("uploads the file to the remote pane and keeps the local source", async () => {
        await enableDualPane();

        await openNewHostModal();
        await fillPasswordHostForm({
            label: "xpane-cp",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("xpane-cp");

        const hostId = await getHostId("xpane-cp");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();
        await waitForBothPanes("sftp");

        // Stage a local source file (the app shares the runner's filesystem).
        const stamp = Date.now();
        const dir = await mkdtemp(join(tmpdir(), "e2e-xpane-cp-"));
        const localPath = join(dir, `copied-${stamp}.txt`);
        await writeFile(localPath, "cross-pane copy payload\n", "utf8");

        await crossPaneCopy("local", [fileEntry(localPath)], REMOTE_HOME);

        // Lands in the remote pane…
        await waitForPaneEntry("sftp", basename(localPath));
        // …and the local source is untouched on disk (copy, not move).
        expect(await exists(localPath)).to.equal(true);
    });
});
