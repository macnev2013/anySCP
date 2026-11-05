// Issue #148: the user chooses where a new split pane's shell starts — the
// home directory (the old, default behaviour) or the directory of the pane
// being split. The choice is a toggle in the pane header (also in Settings).

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

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";
/** testuser's home directory on the linuxserver openssh image. */
const HOME = "/config";

async function terminalIds(): Promise<string[]> {
    return await browser.execute(() =>
        Array.from(document.querySelectorAll("[data-testid^='terminal-']"))
            .map((el) => el.getAttribute("data-session-id") ?? "")
            .filter(Boolean),
    );
}

/** Click a control in `sessionId`'s pane header (hover-revealed, so via JS). */
async function clickInPaneHeader(sessionId: string, selector: string): Promise<void> {
    const anchor = `[data-testid='pane-split-cwd-${sessionId}']`;
    await (await $(anchor)).waitForExist({ timeout: 10_000 });
    await browser.execute(
        (a: string, sel: string) => {
            const btn = a === sel
                ? document.querySelector(a)
                : document.querySelector(a)?.parentElement?.querySelector(sel);
            (btn as HTMLButtonElement).click();
        },
        anchor,
        selector,
    );
}

/** Split `sessionId` down and return the new pane's session id. */
async function splitDown(sessionId: string): Promise<string> {
    const before = await terminalIds();
    await clickInPaneHeader(sessionId, "[aria-label='Split down']");
    let added = "";
    await browser.waitUntil(
        async () => {
            added = (await terminalIds()).find((id) => !before.includes(id)) ?? "";
            return !!added;
        },
        { timeout: 10_000, timeoutMsg: "split pane never opened" },
    );
    return added;
}

/** Upper-cased `pwd` (so the echoed command can't match) of a pane's shell. */
async function expectPwd(sessionId: string, dir: string): Promise<void> {
    await waitForTerminalText(sessionId, "$", { timeoutMs: 15_000 });
    await runCommand(sessionId, "pwd | tr a-z A-Z", dir.toUpperCase(), 15_000);
}

describe("split pane start directory (issue #148)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("opens new splits in home by default and in the pane's directory when toggled", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "split-cwd-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();
        const first = await waitForAnyTerminal();
        await waitForTerminalText(first, ":~$");
        await runCommand(first, "cd /etc && pwd | tr a-z A-Z", "/ETC");

        // Default: off, so the new pane starts in the home directory.
        const toggle = `[data-testid='pane-split-cwd-${first}']`;
        await (await $(toggle)).waitForExist({ timeout: 10_000 });
        expect(await (await $(toggle)).getAttribute("aria-pressed")).to.equal("false");
        const homePane = await splitDown(first);
        await expectPwd(homePane, HOME);

        // Toggle on: the next split lands in /etc, like the source pane.
        await clickInPaneHeader(first, toggle);
        await browser.waitUntil(
            async () => (await (await $(toggle)).getAttribute("aria-pressed")) === "true",
            { timeout: 5_000, timeoutMsg: "toggle never turned on" },
        );
        const cwdPane = await splitDown(first);
        await expectPwd(cwdPane, "/etc");
    });
});
