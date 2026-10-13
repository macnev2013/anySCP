// Issue #138: a tunnel can forward to a host other than the SSH server itself.
// The rule runs over `sshd-bastion`, but its destination is
// `sshd-tunnel-target` — a host on an isolated network the runner can't reach.
// SSHing to the local port and finding the TARGET's hostname proves the traffic
// went runner → bastion → target. (The old dialog always sent "localhost",
// which would land on the bastion's own sshd — same port, different hostname.)

import net from "node:net";
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
import {
    fillRuleAndSave,
    findRuleCard,
    gotoPortForwardingPage,
    openNewRuleDialog,
    toggleRule,
} from "../helpers/port-forwards.js";

const BASTION_HOST = process.env.SSHD_BASTION_HOST ?? "sshd-bastion";
const BASTION_PORT = Number(process.env.SSHD_BASTION_PORT ?? 2222);
const TARGET_HOST = process.env.SSHD_TUNNEL_TARGET_HOST ?? "sshd-tunnel-target";
const TARGET_PORT = Number(process.env.SSHD_TUNNEL_TARGET_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";
const LOCAL_PORT = 17022;
// docker-compose `hostname:` of the isolated target (the bastion is anyscp-bastion).
const TARGET_MARKER = "anyscp-tunnel-target";

/** Connect to 127.0.0.1:port and return the first line the server sends. */
function readBanner(port: number, timeoutMs = 5_000): Promise<string> {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, "127.0.0.1");
        let buf = "";
        const timer = setTimeout(() => {
            sock.destroy();
            reject(new Error(`no banner on :${port} within ${timeoutMs}ms`));
        }, timeoutMs);
        sock.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl >= 0) {
                clearTimeout(timer);
                sock.destroy();
                resolve(buf.slice(0, nl).trim());
            }
        });
        sock.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}

describe("port-forward to another host (#138)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("tunnels through the SSH server to a host only it can reach", async () => {
        // The runner itself must not reach the target, or the test proves nothing.
        let directErr: unknown = null;
        await new Promise<void>((resolve) => {
            const s = net.connect(TARGET_PORT, TARGET_HOST);
            s.setTimeout(3_000, () => { directErr = new Error("timeout"); s.destroy(); resolve(); });
            s.on("connect", () => { s.destroy(); resolve(); });
            s.on("error", (e) => { directErr = e; resolve(); });
        });
        expect(directErr, "tunnel target must be unreachable from the runner").to.not.equal(null);

        await openNewHostModal();
        await fillPasswordHostForm({
            label: "pf-bastion",
            host: BASTION_HOST,
            port: BASTION_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("pf-bastion");
        const hostId = await getHostId("pf-bastion");

        await gotoPortForwardingPage();
        await openNewRuleDialog();
        await fillRuleAndSave({
            label: "to-target",
            hostId,
            localPort: LOCAL_PORT,
            remoteHost: TARGET_HOST,
            remotePort: TARGET_PORT,
        });

        // The card spells out the non-default destination.
        const card = await findRuleCard("to-target");
        const cardText = await browser.execute(
            (sel: string) => document.querySelector(sel)?.textContent ?? "",
            "[data-rule-label='to-target']",
        );
        expect(cardText).to.contain(`${TARGET_HOST}:${TARGET_PORT}`);

        await toggleRule("to-target");
        await browser.waitUntil(
            async () => (await card.$("[role='switch']").getAttribute("aria-checked")) === "true",
            { timeout: 30_000, timeoutMsg: "tunnel never became active" },
        );

        // sshd-tunnel-target's banner arrives over the tunnel.
        let banner = "";
        await browser.waitUntil(
            async () => {
                try {
                    banner = await readBanner(LOCAL_PORT);
                    return banner.startsWith("SSH-");
                } catch {
                    return false;
                }
            },
            { timeout: 30_000, interval: 1_000, timeoutMsg: "no SSH banner through the tunnel" },
        );
        expect(banner).to.match(/^SSH-2\.0-/);

        // Which sshd answered? Log in through the tunnel and ask it.
        await (await $("[aria-label='Hosts']")).click();
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "via-tunnel",
            host: "127.0.0.1",
            port: LOCAL_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        const viaId = await getHostId("via-tunnel");
        const terminalBtn = await $(`[data-testid='host-card-${viaId}-terminal']`);
        await terminalBtn.waitForClickable({ timeout: 10_000 });
        await terminalBtn.click();

        const sessionId = await waitForAnyTerminal(30_000);
        await waitForTerminalText(sessionId, ":~$", { timeoutMs: 30_000 });
        await runCommand(sessionId, "hostname", TARGET_MARKER, 15_000);
    });
});
