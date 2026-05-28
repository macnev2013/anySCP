// Move an entry to a sibling folder — sftp_move_entries removes from source
// and creates at destination atomically (rename on most SFTP servers).

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
    assertEntryAbsent,
    createFolder,
    deleteEntry,
    openEntry,
    refreshExplorer,
    waitForEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";
import {
    activeSftpSessionId,
    sftpMove,
} from "../helpers/transfers.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";
const REMOTE_HOME = "/config";

describe("SFTP move entries", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("moves a folder into a sibling folder", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "mv-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("mv-target");

        const hostId = await getHostId("mv-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const stamp = Date.now();
        const src = `mv-src-${stamp}`;
        const dest = `mv-dst-${stamp}`;
        await createFolder(src);
        await createFolder(dest);

        const sessionId = await activeSftpSessionId();
        await sftpMove(sessionId, [`${REMOTE_HOME}/${src}`], `${REMOTE_HOME}/${dest}`);

        await refreshExplorer();
        await assertEntryAbsent(src);
        await waitForEntry(dest);

        // Verify the moved folder is inside dest.
        await openEntry(dest);
        await refreshExplorer();
        await waitForEntry(src);

        // Back to /config; clean up.
        await browser.execute(() => {
            const buttons = Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                    "[aria-label='Current path'] button",
                ),
            );
            buttons.at(-2)?.click();
        });
        await refreshExplorer();
        await deleteEntry(dest);
    });
});
