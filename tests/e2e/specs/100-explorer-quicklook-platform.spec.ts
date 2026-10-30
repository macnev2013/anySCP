// The Linux E2E runner must never expose native preview controls. This checks
// the real IPC capability, plus the existing file-input keyboard behavior.
import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import { clickSave, fillPasswordHostForm, findHostCardByLabel, getHostId, openNewHostModal, waitForModalClosed } from "../helpers/host.js";
import { createFile, waitForEntry, waitForExplorer } from "../helpers/sftp-ops.js";

describe("Quick Look platform isolation", () => {
    beforeEach(async () => { await resetApp(); await waitForDashboard(); });
    it("keeps Quick Look unavailable on Linux without swallowing Explorer Space", async () => {
        const capabilities = await browser.execute(async () => {
            const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
            return await invoke("quicklook_capabilities") as { supported: boolean; maxBytes: number };
        });
        expect(capabilities).to.deep.equal({ supported: false, maxBytes: 104857600 });
        await openNewHostModal();
        await fillPasswordHostForm({ label: "quicklook-platform", host: process.env.SSHD_PASS_HOST ?? "sshd-pass",
            port: Number(process.env.SSHD_PASS_PORT ?? 2222), username: process.env.SSH_USER ?? "testuser", password: process.env.SSH_PASS ?? "testpass" });
        await clickSave(); await waitForModalClosed(); await findHostCardByLabel("quicklook-platform");
        const hostId = await getHostId("quicklook-platform");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer(); await createFile("quicklook-platform.txt");
        const entry = await waitForEntry("quicklook-platform.txt"); await entry.click();
        const prevented = await browser.execute(() => {
            const row = document.querySelector<HTMLElement>("[data-entry-name='quicklook-platform.txt']")!;
            const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
            row.dispatchEvent(event); return event.defaultPrevented;
        });
        expect(prevented).to.equal(false);
        await entry.click({ button: "right" });
        expect(await $("//button[@role='menuitem' and normalize-space(.)='Quick Look']").isExisting()).to.equal(false);
    });
});
