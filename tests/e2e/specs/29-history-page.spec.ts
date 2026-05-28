// History page: after connecting + disconnecting a host, the History page
// should show an entry for it.

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
import { gotoHistoryPage, historyEntryCount, waitForHistoryEntry } from "../helpers/history.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("history page", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("shows an entry after connecting and disconnecting", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "history-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();
        await waitForModalClosed();

        const sessionId = await waitForAnyTerminal();
        await waitForTerminalText(sessionId, ":~$");

        await gotoHistoryPage();
        await waitForHistoryEntry("history-target");
        expect(await historyEntryCount()).to.be.greaterThan(0);
    });
});
