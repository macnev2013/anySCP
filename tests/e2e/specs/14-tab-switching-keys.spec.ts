// Cmd+1 / Cmd+2 switches active tab — wired in AppShell's shortcuts.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillPasswordHostForm,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import { waitForTabCount } from "../helpers/tabs.js";
import { cmd } from "../helpers/keyboard.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

async function connectFresh(label: string): Promise<void> {
    await openNewHostModal();
    await fillPasswordHostForm({
        label,
        host: SSHD_PASS_HOST,
        port: SSHD_PASS_PORT,
        username: SSH_USER,
        password: SSH_PASS,
    });
    await clickConnect();
    await waitForModalClosed();
}

describe("keyboard: Cmd+1 / Cmd+2", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("switches between tabs by index", async () => {
        await connectFresh("tab-one");
        await waitForTerminalText(await waitForAnyTerminal(), ":~$");

        const hostsTab = await $("[data-tab-label='Hosts']");
        await hostsTab.click();

        await connectFresh("tab-two");
        await waitForTabCount(3);

        // Cmd+1 → Hosts (first tab in tabOrder)
        await cmd("1");
        const tabOne = await $("[data-tab-label='Hosts']");
        await browser.waitUntil(
            async () => {
                const cls = (await tabOne.getAttribute("class")) ?? "";
                return cls.includes("text-accent") || cls.includes("bg-accent");
            },
            { timeout: 5_000, timeoutMsg: "Hosts tab did not activate via Cmd+1" },
        );

        // Cmd+2 → tab-one (or whichever is index 1 — both terminals are valid)
        await cmd("2");
        const activeLabel = await browser.execute(() => {
            const el = document.querySelector(
                "[data-tab-type][class*='text-accent'], [data-tab-type][class*='bg-accent']",
            );
            return el?.getAttribute("data-tab-label") ?? null;
        });
        expect(activeLabel).to.not.equal("Hosts");
    });
});
