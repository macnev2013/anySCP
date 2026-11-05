// Issue #149: from a terminal pane, open the file explorer in the directory
// the shell is in, so files there can be downloaded without navigating to it
// again. Split panes share one SSH connection, so each pane's button must
// land in that pane's own directory.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillPasswordHostForm,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { runCommand, waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import { cmd } from "../helpers/keyboard.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

/** Path shown by the visible explorer's breadcrumb, e.g. "/var/log".
 *  Inactive explorer tabs stay mounted with `visibility: hidden`. */
async function visibleExplorerPath(): Promise<string> {
    return await browser.execute(() => {
        const crumbs = Array.from(
            document.querySelectorAll<HTMLElement>("[aria-label='Current path']"),
        ).find((el) => getComputedStyle(el).visibility === "visible");
        if (!crumbs) return "";
        const parts = Array.from(crumbs.querySelectorAll("button"))
            .map((b) => (b.textContent ?? "").trim())
            .filter((t) => t && t !== "/");
        return "/" + parts.join("/");
    });
}

async function waitForExplorerAt(path: string): Promise<void> {
    let last = "";
    try {
        await browser.waitUntil(
            async () => (last = await visibleExplorerPath()) === path,
            { timeout: 20_000 },
        );
    } catch {
        throw new Error(`explorer never opened at ${path} (showed '${last}')`);
    }
}

/** Click a pane's "open file explorer" button (hover-revealed, so via JS). */
async function openExplorerFromPane(sessionId: string): Promise<void> {
    const sel = `[data-testid='pane-open-explorer-${sessionId}']`;
    await (await $(sel)).waitForExist({ timeout: 10_000 });
    await browser.execute((s: string) => {
        (document.querySelector(s) as HTMLButtonElement).click();
    }, sel);
}

describe("open the file explorer from the terminal (issue #149)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("opens each split pane's explorer in that pane's directory", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "cwd-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();
        const first = await waitForAnyTerminal();
        await waitForTerminalText(first, ":~$");

        await cmd("d");
        await browser.waitUntil(
            async () => (await $$("[data-testid^='terminal-']")).length >= 2,
            { timeout: 10_000, timeoutMsg: "second pane never opened" },
        );
        const second = await browser.execute((sid: string) => {
            const ids = Array.from(document.querySelectorAll("[data-testid^='terminal-']"))
                .map((el) => el.getAttribute("data-session-id"));
            return ids.find((id) => id && id !== sid) ?? "";
        }, first);
        expect(second).to.not.equal("");
        await waitForTerminalText(second, ":~$");

        // Upper-cased `pwd` output proves each command ran: a plain marker
        // would already match the echoed input.
        await runCommand(first, "cd /etc && pwd | tr a-z A-Z", "/ETC");
        // A nested subshell's directory is followed too.
        await runCommand(second, 'cd /usr && PS1="$(echo NESTED | tr A-Z a-z)> " sh', "nested> ");
        await runCommand(second, "cd /usr/bin && pwd | tr a-z A-Z", "/USR/BIN");

        await openExplorerFromPane(first);
        await waitForExplorerAt("/etc");
        expect(await (await $("[data-entry-name='passwd']")).isExisting()).to.equal(true);

        // Back to the terminal tab, then the second pane.
        await (await $("[data-tab-type='terminal']")).click();
        await openExplorerFromPane(second);
        await waitForExplorerAt("/usr/bin");

        expect((await $$("[data-tab-type='sftp']")).length).to.equal(2);
        // The terminal session survives alongside its explorers.
        await (await $("[data-tab-type='terminal']")).click();
        await runCommand(first, "echo still_alive | tr a-z A-Z", "STILL_ALIVE");
    });
});
