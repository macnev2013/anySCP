// Runs against the real Tauri/SQLite and remote listing surfaces.
import { expect } from "chai";
import { resetApp, relaunchApp } from "../helpers/reset.js";
import { waitForPersistedSetting } from "../helpers/settings.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import { openNewHostModal, fillPasswordHostForm, clickSave, waitForModalClosed, getHostId } from "../helpers/host.js";
import { openNewS3Dialog, fillS3Form, clickS3Save, getS3Id } from "../helpers/s3.js";
import { createFile, deleteEntry, waitForExplorer, waitForEntry, assertEntryAbsent, refreshExplorer } from "../helpers/sftp-ops.js";

const toggle = () => $("[data-testid='explorer-hidden-files-toggle']");

async function checkVisibility(): Promise<void> {
    const name = `.e2e-hidden-${Date.now()}`;
    await (await toggle()).waitForClickable({ timeout: 15_000 });
    expect(await (await toggle()).getAttribute("aria-pressed")).to.equal("true");
    await createFile(name);
    try {
        await (await toggle()).click();
        await assertEntryAbsent(name);
        await refreshExplorer();
        await (await $("[data-testid='explorer-refresh']")).waitForEnabled({ timeout: 15_000 });
        expect(await (await toggle()).getAttribute("aria-pressed")).to.equal("false");
        await assertEntryAbsent(name);
        await (await toggle()).click();
        await waitForEntry(name);
    } finally {
        if ((await (await toggle()).getAttribute("aria-pressed")) !== "true") await (await toggle()).click();
        await deleteEntry(name);
    }
}

describe("Explorer hidden-file visibility", () => {
    beforeEach(async () => { await resetApp(); await waitForDashboard(); });

    for (const transport of ["sftp", "scp"] as const) {
        it(`${transport} toggles dot-prefixed files and retains its choice across refresh`, async () => {
            await openNewHostModal();
            await fillPasswordHostForm({
                label: `hidden-${transport}`,
                host: transport === "sftp" ? (process.env.SSHD_PASS_HOST ?? "sshd-pass") : (process.env.SSHD_SCP_HOST ?? "sshd-scp"),
                port: Number(transport === "sftp" ? (process.env.SSHD_PASS_PORT ?? 2222) : (process.env.SSHD_SCP_PORT ?? 2222)),
                username: process.env.SSH_USER ?? "testuser",
                password: process.env.SSH_PASS ?? "testpass",
            });
            await clickSave();
            await waitForModalClosed();
            const id = await getHostId(`hidden-${transport}`);
            await (await $(`[data-testid='host-card-${id}-explorer']`)).click();
            await waitForExplorer();
            await checkVisibility();
        });
    }

    it("S3 toggles dot-prefixed objects and retains its choice across refresh", async () => {
        await openNewS3Dialog();
        await fillS3Form({ label: "hidden-s3", provider: "minio", accessKey: process.env.MINIO_ACCESS_KEY ?? "minioadmin", secretKey: process.env.MINIO_SECRET_KEY ?? "minioadmin", region: "us-east-1", bucket: process.env.MINIO_BUCKET ?? "anyscp-test", endpoint: process.env.MINIO_ENDPOINT ?? "http://minio:9000" });
        await clickS3Save();
        const id = await getS3Id("hidden-s3");
        await (await $(`[data-testid='s3-card-${id}-explorer']`)).click();
        await waitForExplorer();
        await checkVisibility();
    });

    it("persists the global hidden-files default across an app restart", async () => {
        const openSettings = async () => {
            await (await $("[aria-label='Settings']")).click();
            await (await $("[data-testid='settings-nav-explorer']")).click();
            await (await $("[data-testid='s-hidden-files-hide']")).waitForClickable({ timeout: 10_000 });
        };
        await openSettings();
        await (await $("[data-testid='s-hidden-files-hide']")).click();
        // Wait for the actual SQLite write, rather than racing an app restart.
        await waitForPersistedSetting("explorer_show_hidden_files", "false");
        await relaunchApp();
        await openSettings();
        await browser.waitUntil(async () => (await (await $("[data-testid='s-hidden-files-hide']")).getAttribute("aria-checked")) === "true", {
            timeout: 10_000,
            timeoutMsg: "Hidden-files default did not reload as hide after restart",
        });
        expect(await (await $("[data-testid='s-hidden-files-hide']")).getAttribute("aria-checked")).to.equal("true");
    });
});
