// Multi-hop ProxyJump (chained bastions) END-TO-END. Proves a connection
// traverses TWO jump hosts, which is the capability the recursive `establish`
// rewrite added (the old single-hop code could not do this at all).
//
// Topology (see docker-compose.yml):
//   runner ──e2e──▶ sshd-bastion ──e2e-internal──▶ sshd-bastion2 ──e2e-internal2──▶ sshd-deep-target
// The deep target and bastion2 share NO network with the runner, so the only
// way to reach the deep target is to hop bastion1 → bastion2. A working shell on
// it (hostname == anyscp-deep-target) can only mean both hops were traversed.
//
// Regression value: on the pre-fix single-hop code this test FAILS — that code
// connected directly to the immediate jump (bastion2), which the runner can't
// reach, so the connection never establishes.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
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
const BASTION2_HOST = process.env.SSHD_BASTION2_HOST ?? "sshd-bastion2";
const BASTION2_PORT = Number(process.env.SSHD_BASTION2_PORT ?? 2222);
const DEEP_TARGET_HOST = process.env.SSHD_DEEP_TARGET_HOST ?? "sshd-deep-target";
const DEEP_TARGET_PORT = Number(process.env.SSHD_DEEP_TARGET_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

const DEEP_TARGET_MARKER = "anyscp-deep-target";

/** Save a password host, optionally tunnelled through `tunnelHostId`. */
async function saveHost(
    label: string,
    host: string,
    port: number,
    tunnelHostId?: string,
): Promise<string> {
    await openNewHostModal();
    await fillPasswordHostForm({ label, host, port, username: SSH_USER, password: SSH_PASS });
    if (tunnelHostId) {
        await setTunnelEnabled(true);
        await selectTunnelHost(tunnelHostId);
    }
    await clickSave();
    await waitForModalClosed();
    await findHostCardByLabel(label);
    return getHostId(label);
}

describe("ProxyJump multi-hop (chained bastions)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("connects through a two-bastion chain to an isolated target", async () => {
        // bastion1 (runner-reachable) ← bastion2 tunnels through it ← deep target
        // tunnels through bastion2. Saving in dependency order so each tunnel
        // host already exists in the picker.
        const bastion1Id = await saveHost("chain-bastion1", BASTION_HOST, BASTION_PORT);
        const bastion2Id = await saveHost(
            "chain-bastion2",
            BASTION2_HOST,
            BASTION2_PORT,
            bastion1Id,
        );
        const deepId = await saveHost(
            "chain-deep-target",
            DEEP_TARGET_HOST,
            DEEP_TARGET_PORT,
            bastion2Id,
        );

        // Connect the deep target from its card → connect_saved_host resolves the
        // full chain (deep → bastion2 → bastion1) and establishes it hop by hop.
        const terminalBtn = await $(`[data-testid='host-card-${deepId}-terminal']`);
        await terminalBtn.waitForClickable({ timeout: 10_000 });
        await terminalBtn.click();

        const sessionId = await waitForAnyTerminal(40_000);
        // Two sequential SSH handshakes + auths before the target shell — allow
        // extra time for the chain to come up.
        await waitForTerminalText(sessionId, ":~$", { timeoutMs: 40_000 });

        // The shell must be on the doubly-isolated deep target, reachable only by
        // traversing BOTH bastions — this is the whole proof of multi-hop.
        await runCommand(sessionId, "hostname", DEEP_TARGET_MARKER, 15_000);
    });
});
