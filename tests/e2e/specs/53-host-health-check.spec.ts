// Host health-check button on the dashboard card. Saves a host (no connect),
// clicks the Activity button, and asserts the status label. Covers the two
// deterministic outcomes: a reachable SSH server and a closed TCP port.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    getHostId,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

/** Click the health button for a saved host; returns its host id. */
async function clickHealthCheck(label: string): Promise<string> {
    const id = await getHostId(label);
    const btn = await $(`[data-testid='host-card-${id}-health']`);
    await btn.waitForClickable({ timeout: 10_000 });
    await btn.click();
    return id;
}

/** Read the live health-status text straight from the DOM. getText() is
 *  unreliable for this small truncated element under WebKitWebDriver, so read
 *  textContent directly (same approach as the suite's other __e2e hooks). */
async function readHealthStatus(id: string): Promise<string> {
    return browser.execute((testid: string) => {
        const el = document.querySelector(`[data-testid="${testid}"]`);
        return el?.textContent ?? "";
    }, `host-card-${id}-health-status`);
}

describe("host health check", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("reports a reachable SSH host", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "health-ok",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();

        const id = await clickHealthCheck("health-ok");
        await browser.waitUntil(
            async () => (await readHealthStatus(id)).includes("SSH reachable"),
            { timeout: 20_000, timeoutMsg: "health status did not become reachable" },
        );
    });

    it("reports a closed port as unreachable", async () => {
        await openNewHostModal();
        // Port 1 on the runner — guaranteed closed; the TCP stage returns
        // connection-refused within a couple of seconds.
        await fillPasswordHostForm({
            label: "health-closed",
            host: "127.0.0.1",
            port: 1,
            username: SSH_USER,
            password: "anything",
        });
        await clickSave();
        await waitForModalClosed();

        const id = await clickHealthCheck("health-closed");
        await browser.waitUntil(
            async () => (await readHealthStatus(id)).includes("Port unreachable"),
            { timeout: 20_000, timeoutMsg: "health status did not become port-unreachable" },
        );
        expect(await readHealthStatus(id)).to.include("Port unreachable");
    });
});
