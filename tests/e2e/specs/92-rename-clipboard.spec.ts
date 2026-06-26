// Issue #87 / PR #92: native copy/cut/paste/select-all must work INSIDE the
// inline rename input. The file-row keydown handler used to intercept
// Ctrl+C/X/V/A even while the rename <input> was focused (calling
// preventDefault), so copying the highlighted name put nothing on the OS
// clipboard. The fix guards those branches with !isInput.
//
// We can't read the OS clipboard directly in the WebKit/Xvfb runner, so we
// prove the native path end-to-end with a clipboard round-trip driven entirely
// by real keystrokes: select-all (Ctrl+A) -> copy (Ctrl+C) -> clear the field
// -> paste (Ctrl+V). If any of those were still swallowed by the row handler,
// the field would not come back to the original text.

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
    navigateUp,
    openEntry,
    refreshExplorer,
    waitForEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

const RENAME_INPUT = "[data-testid='explorer-rename-input']";

async function startRename(name: string): Promise<void> {
    await waitForEntry(name);
    await browser.execute((n: string) => {
        const fn = (window as unknown as {
            __e2eExplorerStartRename?: (o: string, newName?: string) => void;
        }).__e2eExplorerStartRename;
        if (!fn) throw new Error("__e2eExplorerStartRename not registered");
        fn(n); // open the inline rename input showing the current name
    }, name);
    const input = await $(RENAME_INPUT);
    await input.waitForExist({ timeout: 5_000 });
}

async function connectAndOpenExplorer(label: string): Promise<void> {
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
}

describe("Explorer rename field — native clipboard (issue #87)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("Ctrl+A/C/V operate on the text in the rename field", async () => {
        await connectAndOpenExplorer("rename-clip");

        const original = `clip-${Date.now()}`;
        await createFile(original);

        await startRename(original);
        const input = await $(RENAME_INPUT);
        await input.click(); // focus the field

        // select-all (Ctrl+A) + copy (Ctrl+C) the current name
        await browser.keys(["Control", "a"]);
        await browser.keys(["Control", "c"]);

        // clear the field: select-all then delete
        await browser.keys(["Control", "a"]);
        await browser.keys(["Backspace"]);
        await expect(input).toHaveValue("");

        // paste (Ctrl+V) — round-trips only if the native copy actually landed
        await browser.keys(["Control", "v"]);
        await expect(input).toHaveValue(original);

        // cancel the rename (leave the file untouched) and clean up
        await browser.keys(["Escape"]);
        await refreshExplorer();
        await deleteEntry(original);
    });

    it("file-row Ctrl+C / Ctrl+V still copy files (no regression)", async () => {
        await connectAndOpenExplorer("row-clip");

        const stamp = Date.now();
        const file = `rowfile-${stamp}`;
        const dest = `rowdest-${stamp}`;
        const keep = `keep-${stamp}`;
        await createFile(file);
        await createFolder(dest);

        // Seed the destination with a placeholder so it has a focusable row —
        // the row-level Ctrl+V handler needs a focused [data-entry-row].
        await openEntry(dest);
        await createFile(keep);
        await navigateUp();
        await refreshExplorer();

        // focus the file ROW (not an input) and copy it
        await (await waitForEntry(file)).click();
        await browser.keys(["Control", "c"]);

        // into the destination folder, focus a row, then paste
        await openEntry(dest);
        await refreshExplorer();
        await (await waitForEntry(keep)).click();
        await browser.keys(["Control", "v"]);
        await waitForEntry(file); // copied file shows up in the subfolder

        // back out and clean up everything
        await deleteEntry(file);
        await deleteEntry(keep);
        await navigateUp();
        await refreshExplorer();
        await deleteEntry(file);
        await deleteEntry(dest);
    });
});
