// Issue #140: with double-click set to "Open", binaries (PDF, images,
// documents, …) silently downloaded instead of opening. They now open in the
// OS default app for their type.
//
// On Linux the app hands the file to `xdg-open`. A stand-in xdg-open earlier on
// PATH records what it was asked to open, proving the real app downloaded the
// remote file and passed it to the system opener (and didn't download it).

import { execSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { runCommand, waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import { waitForEntry, waitForExplorer } from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

const PDF = "report-140.pdf";
const SHIM = "/usr/local/bin/xdg-open";
const CALLS = "/tmp/xdg-open-calls.log";

async function errorToasts(): Promise<string[]> {
    return await browser.execute(() =>
        Array.from(document.querySelectorAll("[role='alert']")).map((el) => el.textContent ?? ""),
    );
}

describe("SFTP double-click opens binaries in the default app (#140)", () => {
    before(() => {
        // `which` must resolve the shim ahead of any real xdg-open.
        writeFileSync(SHIM, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${CALLS}\n`, { mode: 0o755 });
        expect(execSync("command -v xdg-open", { shell: "/bin/sh" }).toString().trim()).to.equal(SHIM);
    });

    after(() => {
        rmSync(SHIM, { force: true });
        rmSync(CALLS, { force: true });
    });

    beforeEach(async () => {
        rmSync(CALLS, { force: true });
        await resetApp();
        await waitForDashboard();
    });

    it("hands a double-clicked PDF to the system opener", async () => {
        // Double-click action → Open. No editor needed for binaries.
        const nav = await $("[aria-label='Settings']");
        await nav.waitForClickable({ timeout: 10_000 });
        await nav.click();
        await (await $("[data-testid='settings-nav-explorer']")).click();
        const openOpt = await $("[data-testid='s-doubleclick-open']");
        await openOpt.waitForClickable({ timeout: 10_000 });
        await openOpt.click();

        await (await $("[aria-label='Hosts']")).click();
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "pdf-host",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("pdf-host");
        const hostId = await getHostId("pdf-host");

        // Seed a small PDF-looking file in the remote home.
        await (await $(`[data-testid='host-card-${hostId}-terminal']`)).click();
        const sessionId = await waitForAnyTerminal(30_000);
        await waitForTerminalText(sessionId, ":~$", { timeoutMs: 30_000 });
        await runCommand(sessionId, `printf '%%PDF-1.4 e2e-140' > ~/${PDF} && echo SEEDED-140`, "SEEDED-140");

        await (await $("[aria-label='Hosts']")).click();
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();
        await (await waitForEntry(PDF, 20_000)).doubleClick();

        // The opener was called with a local staged copy of the remote file.
        let opened = "";
        await browser.waitUntil(
            () => {
                if (!existsSync(CALLS)) return false;
                opened = readFileSync(CALLS, "utf8").trim().split("\n").pop() ?? "";
                return opened.endsWith(`/${PDF}`);
            },
            { timeout: 20_000, timeoutMsg: "xdg-open was never called for the PDF" },
        );
        expect(readFileSync(opened, "utf8")).to.equal("%PDF-1.4 e2e-140");
        expect(await errorToasts(), "opening should not report an error").to.deep.equal([]);
    });
});
