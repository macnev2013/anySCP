// Host duplicate — clones an existing host with " (copy)" suffix on the
// label. Triggered via the duplicate hook (UI version lives in the
// right-click context menu, which is flaky in WebKitWebDriver).

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { hostCardCount, waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    duplicateHost,
    fillPasswordHostForm,
    findHostCardByLabel,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("host duplicate", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("creates a copy with '(copy)' suffix and a new id", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "original",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("original");

        await duplicateHost("original");

        await findHostCardByLabel("original (copy)");
        expect(await hostCardCount()).to.equal(2);
    });
});
