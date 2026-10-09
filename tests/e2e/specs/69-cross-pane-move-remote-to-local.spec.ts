// Cross-pane MOVE, remote → local (dual-pane explorer): the highest-damage
// direction — a successful move deletes the REMOTE source. Download the file
// into the local pane, then the remote original must be removed, but only once
// the download has actually landed. Verified against a live SFTP server.

import { expect } from "chai";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { activeSftpSessionId, sftpUpload } from "../helpers/transfers.js";
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

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

describe("cross-pane move (remote → local)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("downloads the file locally and deletes the remote source once it lands", async () => {
        await enableDualPane();
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "xpane-mv-r2l",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("xpane-mv-r2l");

        const hostId = await getHostId("xpane-mv-r2l");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();
        await waitForBothPanes("sftp");

        // Seed a REMOTE source file by uploading a known payload into the home dir.
        const stamp = Date.now();
        const staging = await mkdtemp(join(tmpdir(), "e2e-xpane-r2l-src-"));
        const name = `r2l-${stamp}.txt`;
        const localStage = join(staging, name);
        await writeFile(localStage, "remote-to-local payload\n", "utf8");
        const sessionId = await activeSftpSessionId();
        await sftpUpload(sessionId, localStage, `${REMOTE_HOME}/${name}`);
        await waitForPaneEntry("sftp", name);

        // Move it back the other way: remote → a fresh local dir.
        const dest = await mkdtemp(join(tmpdir(), "e2e-xpane-r2l-dst-"));
        const remoteEntry: CrossPaneEntry = { id: `${REMOTE_HOME}/${name}`, name, entryType: "File" };
        await crossPaneMove("remote", [remoteEntry], dest);

        // The file lands locally with its bytes intact…
        const landed = join(dest, name);
        await browser.waitUntil(async () => await exists(landed), {
            timeout: 20_000,
            timeoutMsg: "remote→local move never wrote the file to the local dir",
        });
        expect(await readFile(landed, "utf8")).to.equal("remote-to-local payload\n");

        // …and the REMOTE source is deleted, but only after the download landed.
        await browser.waitUntil(
            async () => {
                await refreshPane("sftp");
                return !(await paneEntryExists("sftp", name));
            },
            { timeout: 15_000, timeoutMsg: "remote source was never deleted after the move landed" },
        );
    });
});
