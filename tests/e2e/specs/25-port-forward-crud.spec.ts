// Port-forward rule CRUD: create a rule against a saved host, find it,
// delete it. Doesn't actually start the tunnel — that would require the
// linuxserver sshd image to allow port forwarding which isn't enabled by
// default.

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
import {
    deleteRule,
    fillRuleAndSave,
    findRuleCard,
    gotoPortForwardingPage,
    openNewRuleDialog,
    ruleCount,
} from "../helpers/port-forwards.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("port-forward CRUD", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("creates a rule against a host, then deletes it", async () => {
        // Need at least one host so the rule dialog's host CustomSelect is non-empty.
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "pf-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("pf-target");
        const hostId = await getHostId("pf-target");

        await gotoPortForwardingPage();
        expect(await ruleCount()).to.equal(0);

        await openNewRuleDialog();
        await fillRuleAndSave({
            label: "tunnel-1",
            hostId,
            localPort: 15432,
            remotePort: 5432,
        });
        await findRuleCard("tunnel-1");
        expect(await ruleCount()).to.equal(1);

        await deleteRule("tunnel-1");
        expect(await ruleCount()).to.equal(0);
    });
});
