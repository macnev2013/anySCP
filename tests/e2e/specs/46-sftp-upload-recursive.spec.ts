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
    entryOrder,
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

        // Navigate in and verify the tree contents. The recursive upload is a
        // single async transfer that mkdir's the top-level dir BEFORE writing its
        // files and only signals completion once via a transfer event, so a bare
        // waitForEntry can race the still-running upload (the dir exists but its
        // files don't yet). Re-list the sub-directory each iteration until every
        // expected entry lands — deterministic regardless of when the upload
        // finishes or when the app's auto-refresh fires.
        await openEntry(dirName);

        // Wait for the navigation into the sub-dir to SETTLE before refreshing —
        // refreshing while the navigation is still in flight could re-list (and
        // bounce back to) the parent. The "Navigate to <home>" breadcrumb crumb
        // is only rendered once <home> is no longer the last segment, i.e. once
        // we've descended into the uploaded dir.
        const parentCrumbSelector =
            `[aria-label='Current path'] button[title='Navigate to ${REMOTE_HOME}']`;
        await browser.waitUntil(
            async () => (await $(parentCrumbSelector)).isExisting(),
            { timeout: 10_000, timeoutMsg: `never navigated into '${dirName}'` },
        );

        // Now poll-with-refresh until every uploaded entry lands in the sub-dir.
        await browser.waitUntil(
            async () => {
                await refreshExplorer();
                const names = await entryOrder();
                return ["a.txt", "b.txt", "nested"].every((n) => names.includes(n));
            },
            {
                timeout: 30_000,
                timeoutMsg: `uploaded files never appeared inside '${dirName}'`,
            },
        );

        // Cleanup — go back to /config (target the breadcrumb segment by title so
        // it's independent of breadcrumb depth), wait for the re-list, then
        // bulk-delete the uploaded dir.
        const configCrumb = await $(parentCrumbSelector);
        await configCrumb.waitForClickable({ timeout: 5_000 });
        await configCrumb.click();
        await waitForEntry(dirName);
        await multiSelectAndDelete([dirName]);
    });
});
