// Settings → Data: encrypted backup / restore + factory reset.
//
// The native save/open file dialogs and the post-import app relaunch can't be
// driven through WebDriver, so the data-mutating steps invoke the backend
// commands directly (helpers/backup.ts) with explicit temp paths — the same
// approach the transfer specs use for the file picker. End-to-end behaviour is
// then verified through the REAL UI: relaunch the app (which re-reads the DB,
// exactly as the production import/reset flow does) and assert the dashboard.
// The passphrase modal and the typed-DELETE confirmation gating are exercised
// against the real UI separately.
//
// Because the WDIO process runs in the same container as the app, the spec can
// also read the written backup file off disk and assert it's a binary container
// (magic header), not the old JSON+base64 envelope.

import { expect } from "chai";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { resetApp, relaunchApp } from "../helpers/reset.js";
import { waitForDashboard, hostCardCount } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    assertHostAbsent,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { openNewGroupModal, fillGroupAndSave } from "../helpers/groups.js";
import { gotoSnippetsPage, openNewSnippetModal, fillSnippetAndSave } from "../helpers/snippets.js";
import { backupExport, backupImport, factoryReset, dataCounts } from "../helpers/backup.js";

const PASSWORD = "e2e-backup-pass-123";
const createdFiles: string[] = [];

function tmpBackupPath(): string {
    const name = `anyscp-e2e-backup-${Date.now()}-${Math.random().toString(36).slice(2)}.ascpbak`;
    const p = join(tmpdir(), name);
    createdFiles.push(p);
    return p;
}

async function seedHost(label: string): Promise<void> {
    await openNewHostModal();
    await fillPasswordHostForm({
        label,
        host: "192.0.2.10",
        port: 22,
        username: "tester",
        password: "hunter2",
    });
    await clickSave();
    await waitForModalClosed();
    await findHostCardByLabel(label); // confirm it landed on the dashboard
}

async function openSettingsData(): Promise<void> {
    const nav = await $("[aria-label='Settings']");
    await nav.waitForClickable({ timeout: 10_000 });
    await nav.click();
    const tab = await $("[data-testid='settings-nav-data']");
    await tab.waitForClickable({ timeout: 10_000 });
    await tab.click();
}

describe("Settings → Data: backup & restore", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    after(async () => {
        for (const f of createdFiles) await rm(f, { force: true });
    });

    it("adds data, backs it up, clears it, then restores everything from the backup", async () => {
        const hostLabel = "Backup Target";
        const groupName = "Backup Group";
        const snippetName = "Backup Snippet";

        // 1. Add data of several kinds (host + group on the dashboard, then a snippet).
        await seedHost(hostLabel);
        await openNewGroupModal();
        await fillGroupAndSave(groupName);
        await gotoSnippetsPage();
        await openNewSnippetModal();
        await fillSnippetAndSave({ name: snippetName, command: "echo hello" });

        expect(await dataCounts()).to.deep.equal({ hosts: 1, groups: 1, snippets: 1 });

        // 2. Take an encrypted backup.
        const path = tmpBackupPath();
        await backupExport(PASSWORD, path);

        // It's a compact BINARY container (magic "ASCPBAK"), not JSON/base64,
        // and far smaller than the old format would have produced.
        const bytes = await readFile(path);
        expect(bytes.subarray(0, 7).toString("latin1")).to.equal("ASCPBAK");
        expect(bytes[0]).to.not.equal("{".charCodeAt(0)); // not a JSON document
        expect(bytes.length).to.be.greaterThan(40); // header + ciphertext
        expect(bytes.length).to.be.lessThan(64 * 1024); // not the old ~190KB bloat

        // 3. Wipe everything, relaunch, and confirm NOTHING is left.
        await factoryReset();
        await relaunchApp();
        await waitForDashboard();
        expect(await dataCounts()).to.deep.equal({ hosts: 0, groups: 0, snippets: 0 });
        await assertHostAbsent(hostLabel);
        expect(await hostCardCount()).to.equal(0);

        // 4. Restore from the backup, relaunch, and confirm EVERYTHING is back.
        await backupImport(PASSWORD, path);
        await relaunchApp();
        await waitForDashboard();
        expect(await dataCounts()).to.deep.equal({ hosts: 1, groups: 1, snippets: 1 });
        await findHostCardByLabel(hostLabel);
        expect(await hostCardCount()).to.equal(1);
    });

    it("rejects import with the wrong password", async () => {
        await seedHost("Wrong Pw Host");
        const path = tmpBackupPath();
        await backupExport(PASSWORD, path);

        let threw = false;
        try {
            await backupImport("not-the-password", path);
        } catch {
            threw = true;
        }
        expect(threw, "import with the wrong password must reject").to.equal(true);
    });

    it("rejects a file that isn't an anySCP backup", async () => {
        const path = join(tmpdir(), `anyscp-e2e-notabackup-${Date.now()}.ascpbak`);
        createdFiles.push(path);
        await writeFile(path, "this is definitely not an anySCP backup");

        let threw = false;
        try {
            await backupImport(PASSWORD, path);
        } catch {
            threw = true;
        }
        expect(threw, "import of a non-backup file must reject").to.equal(true);
    });
});

describe("Settings → Data: UI gating", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
        await openSettingsData();
    });

    it("shows Export, Import, and Clear-all-data actions", async () => {
        await (await $("[data-testid='s-export-backup']")).waitForDisplayed({ timeout: 10_000 });
        await (await $("[data-testid='s-import-backup']")).waitForDisplayed({ timeout: 10_000 });
        await (await $("[data-testid='s-clear-data']")).waitForDisplayed({ timeout: 10_000 });
    });

    it("clear-all-data stays disabled until you type DELETE", async () => {
        await (await $("[data-testid='s-clear-data']")).click();
        const submit = await $("[data-testid='reset-confirm-submit']");
        await submit.waitForDisplayed({ timeout: 5_000 });
        expect(await submit.isEnabled()).to.equal(false);

        await (await $("[data-testid='reset-confirm-input']")).setValue("DELETE");
        await browser.waitUntil(async () => await submit.isEnabled(), {
            timeout: 5_000,
            timeoutMsg: "Clear-all-data submit never enabled after typing DELETE",
        });

        // Close WITHOUT confirming — must not wipe anything.
        await browser.keys("Escape");
    });

    it("export submit stays disabled until passwords match and are long enough", async () => {
        await (await $("[data-testid='s-export-backup']")).click();
        const submit = await $("[data-testid='backup-submit']");
        await submit.waitForDisplayed({ timeout: 5_000 });
        expect(await submit.isEnabled()).to.equal(false);

        const pw = await $("[data-testid='backup-password']");
        const confirm = await $("[data-testid='backup-password-confirm']");

        // Too short (matching but < 8 chars).
        await pw.setValue("short");
        await confirm.setValue("short");
        expect(await submit.isEnabled()).to.equal(false);

        // Long enough but mismatched.
        await pw.setValue("longenough1");
        await confirm.setValue("different123");
        expect(await submit.isEnabled()).to.equal(false);

        // Long + matching → enabled.
        await confirm.setValue("longenough1");
        await browser.waitUntil(async () => await submit.isEnabled(), {
            timeout: 5_000,
            timeoutMsg: "Export submit never enabled with matching long passwords",
        });

        await browser.keys("Escape");
    });
});
