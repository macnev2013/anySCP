// Issue #151: creating a file/folder where the user lacks write permission
// failed silently — the inline row vanished and nothing told the user why.
// `/` is root-owned on the target, so testuser's mkdir/create there is denied
// and the explorer must say so.

import { expect } from "chai";
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
    navigateExplorerHome,
    waitForEntry,
    waitForExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

/** Texts of the error toasts currently on screen. */
async function alertTexts(): Promise<string[]> {
    return await browser.execute(() =>
        Array.from(document.querySelectorAll("[role='alert']")).map((el) => el.textContent ?? ""),
    );
}

async function waitForAlert(fragment: string): Promise<string> {
    let found = "";
    await browser.waitUntil(
        async () => {
            found = (await alertTexts()).find((t) => t.includes(fragment)) ?? "";
            return found !== "";
        },
        { timeout: 10_000, timeoutMsg: `no error toast containing "${fragment}"` },
    );
    return found;
}

async function submitInline(buttonTestId: string, inputTestId: string, name: string): Promise<void> {
    await (await $(`[data-testid='${buttonTestId}']`)).click();
    const input = await $(`[data-testid='${inputTestId}']`);
    await input.waitForDisplayed({ timeout: 5_000 });
    await input.setValue(name);
    await browser.keys(["Enter"]);
}

describe("SFTP create without permission (#151)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("shows an error when a folder or file can't be created", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "perm-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("perm-target");

        const hostId = await getHostId("perm-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        await navigateExplorerHome();
        await waitForEntry("etc");

        const folder = "e2e-denied-" + Date.now();
        await submitInline("explorer-new-folder", "explorer-new-folder-input", folder);
        const folderMsg = await waitForAlert(`Couldn't create folder "${folder}"`);
        expect(folderMsg.toLowerCase()).to.contain("permission");
        await assertEntryAbsent(folder);

        const file = "e2e-denied-" + Date.now() + ".txt";
        await submitInline("explorer-new-file", "explorer-new-file-input", file);
        const fileMsg = await waitForAlert(`Couldn't create file "${file}"`);
        expect(fileMsg.toLowerCase()).to.contain("permission");
        await assertEntryAbsent(file);
    });
});
