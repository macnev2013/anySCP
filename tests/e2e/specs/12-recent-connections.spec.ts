// Recent connections — after Connect → disconnect, the host appears in the
// "Recent" list at the top of the dashboard.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    fillPasswordHostForm,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";
import { waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";
import { waitForRecent } from "../helpers/recent.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("recent connections", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("records a successful connection in the recent list", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "recent-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        // Switch back to the hosts page (Cmd+1 → first tab is the permanent
        // Hosts tab). The recent-connections list lives on the dashboard.
        const hostsTab = await $("[data-tab-label='Hosts']");
        await hostsTab.click();

        await waitForRecent("recent-target", 10_000);
    });
});
