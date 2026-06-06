// ProxyJump END-TO-END: proves a saved host actually connects THROUGH a jump
// host. `sshd-tunnel-target` lives on an isolated docker network the runner
// can't reach, bridged only by `sshd-bastion`. So:
//   • a DIRECT connection to the target must fail (it's unreachable), and
//   • a TUNNELLED connection (proxy_jump_host_id → bastion) must succeed and
//     land a real shell on the target (hostname == anyscp-tunnel-target).
// Together these show the tunnel — not direct reachability — is what works.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickConnect,
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    getHostId,
    openNewHostModal,
    selectTunnelHost,
    setTunnelEnabled,
    waitForModalClosed,
} from "../helpers/host.js";
import { runCommand, waitForAnyTerminal, waitForTerminalText } from "../helpers/terminal.js";

const BASTION_HOST = process.env.SSHD_BASTION_HOST ?? "sshd-bastion";
const BASTION_PORT = Number(process.env.SSHD_BASTION_PORT ?? 2222);
const TARGET_HOST = process.env.SSHD_TUNNEL_TARGET_HOST ?? "sshd-tunnel-target";
const TARGET_PORT = Number(process.env.SSHD_TUNNEL_TARGET_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

// The target's container hostname (docker-compose `hostname:`). A shell that
// reports this name can only have been reached through the bastion tunnel.
const TARGET_MARKER = "anyscp-tunnel-target";

describe("ProxyJump end-to-end", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("cannot reach the isolated target directly (isolation guard)", async () => {
        // Sanity: without a tunnel the target is unreachable from the runner, so
        // a direct connect must surface an error rather than a terminal. If this
        // ever passes, the network isolation is broken and the positive test
        // below would no longer prove anything.
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "direct-fail",
            host: TARGET_HOST,
            port: TARGET_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickConnect();

        const err = await $("[data-testid='host-modal-error']");
        await err.waitForDisplayed({ timeout: 30_000 });
        expect((await err.getText()).length).to.be.greaterThan(0);
    });

    it("connects through the bastion and runs a command on the target", async () => {
        // 1. Save the bastion so it becomes selectable as a tunnel host.
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "bastion",
            host: BASTION_HOST,
            port: BASTION_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("bastion");
        const bastionId = await getHostId("bastion");

        // 2. Save the target with the tunnel routed through the bastion.
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "tunnel-target",
            host: TARGET_HOST,
            port: TARGET_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await setTunnelEnabled(true);
        await selectTunnelHost(bastionId);
        await clickSave();
        await waitForModalClosed();
        const targetId = await getHostId("tunnel-target");

        // 3. Connect the SAVED target from its card (uses connect_saved_host,
        //    which resolves proxy_jump_host_id → the bastion and tunnels).
        const terminalBtn = await $(`[data-testid='host-card-${targetId}-terminal']`);
        await terminalBtn.waitForClickable({ timeout: 10_000 });
        await terminalBtn.click();

        const sessionId = await waitForAnyTerminal(30_000);
        await waitForTerminalText(sessionId, ":~$", { timeoutMs: 30_000 });

        // 4. The shell must be on the ISOLATED target, only reachable via the
        //    tunnel — `hostname` proves which host we actually landed on.
        await runCommand(sessionId, "hostname", TARGET_MARKER, 15_000);
    });
});
