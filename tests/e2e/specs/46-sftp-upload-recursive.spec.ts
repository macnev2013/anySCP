// Recursive upload — create a local directory with nested files, enqueue
// the dir for upload, then verify the top-level dir appears remotely and
// (after navigating into it) contains the expected files.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
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
    multiSelectAndDelete,
    openEntry,
    refreshExplorer,
    waitForEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";
import {
    activeSftpSessionId,
    sftpEnqueueUpload,
} from "../helpers/transfers.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";
const REMOTE_HOME = "/config";

describe("SFTP recursive upload", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("uploads a directory tree (parent + 2 nested files)", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "rec-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("rec-target");

        const hostId = await getHostId("rec-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        // Build local tree: <tmp>/e2e-rec-<stamp>/{a.txt,b.txt}
        const stamp = Date.now();
        const tree = await mkdtemp(join(tmpdir(), `e2e-rec-${stamp}-`));
        await writeFile(join(tree, "a.txt"), "alpha\n", "utf8");
        await writeFile(join(tree, "b.txt"), "beta\n", "utf8");
        // Add a nested subdir to prove depth handling.
        await mkdir(join(tree, "nested"), { recursive: true });
        await writeFile(join(tree, "nested", "deep.txt"), "deep\n", "utf8");

        const dirName = tree.split("/").pop()!;

        const sessionId = await activeSftpSessionId();
        await sftpEnqueueUpload(sessionId, [tree], REMOTE_HOME);

        // Wait for the top-level dir to land remotely.
        await browser.waitUntil(
            async () => {
                await refreshExplorer();
                return await (await $(`[data-entry-name='${dirName}']`)).isExisting();
            },
            { timeout: 20_000, timeoutMsg: `uploaded dir '${dirName}' never appeared` },
        );

        // Navigate in and verify the two files at the top of the tree.
        await openEntry(dirName);
        await waitForEntry("a.txt");
        await waitForEntry("b.txt");
        await waitForEntry("nested");

        // Cleanup — go back to /config, bulk-delete the uploaded dir.
        await browser.execute(() => {
            const buttons = Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                    "[aria-label='Current path'] button",
                ),
            );
            buttons.at(-2)?.click();
        });
        await refreshExplorer();
        await multiSelectAndDelete([dirName]);
    });
});
