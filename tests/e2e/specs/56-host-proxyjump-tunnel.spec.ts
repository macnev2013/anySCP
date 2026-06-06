// ProxyJump / SSH tunnel UI. Covers the HostEditModal tunnel toggle + host
// selector (proxy_jump_host_id persistence), self-exclusion from the dropdown,
// the HostCard "via …" badge, and the zero-candidate disabled state.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    findHostCardByLabel,
    getHostId,
    openHostEdit,
    openNewHostModal,
    setTunnelEnabled,
    waitForModalClosed,
} from "../helpers/host.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

async function seedHost(label: string): Promise<void> {
    await openNewHostModal();
    await fillPasswordHostForm({
        label,
        host: SSHD_PASS_HOST,
        port: SSHD_PASS_PORT,
        username: SSH_USER,
        password: SSH_PASS,
    });
    await clickSave();
    await waitForModalClosed();
    await findHostCardByLabel(label);
}

describe("ProxyJump tunnel UI", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("links a host through a tunnel host and shows the 'via' badge", async () => {
        await seedHost("bastion");
        await seedHost("target");

        const bastionId = await getHostId("bastion");
        const targetId = await getHostId("target");

        // Enable the tunnel on `target` and route it through `bastion`.
        await openHostEdit("target");
        await setTunnelEnabled(true);

        // Open the host dropdown once: assert the edited host is excluded (a host
        // can't tunnel through itself), then pick `bastion` from the open list.
        const trigger = await $("[data-testid='host-modal-tunnel-host']");
        await trigger.waitForClickable({ timeout: 5_000 });
        await trigger.click();

        const selfExists = await (
            await $(`[data-testid='host-modal-tunnel-host-option-${targetId}']`)
        ).isExisting();
        expect(selfExists, "host must not tunnel through itself").to.equal(false);

        const bastionOption = await $(
            `[data-testid='host-modal-tunnel-host-option-${bastionId}']`,
        );
        await bastionOption.waitForDisplayed({ timeout: 5_000 });
        await bastionOption.click();

        await clickSave();
        await waitForModalClosed();

        // The card renders a "via bastion" badge. Read textContent directly —
        // WebKitWebDriver getText() returns "" for small/truncated elements.
        const badgeSel = `[data-testid='host-card-${targetId}-tunnel']`;
        await (await $(badgeSel)).waitForExist({ timeout: 10_000 });
        const text = await browser.execute(
            (sel: string) => document.querySelector(sel)?.textContent ?? "",
            badgeSel,
        );
        expect(text).to.contain("via");
        expect(text).to.contain("bastion");

        // Persistence: reopen the editor and confirm the toggle stays enabled.
        await openHostEdit("target");
        const checkbox = await $("[data-testid='host-modal-tunnel-enabled']");
        expect(await checkbox.isSelected(), "tunnel toggle should persist").to.equal(true);
    });

    it("disables the tunnel toggle when there is no other host to tunnel through", async () => {
        await seedHost("solo");

        await openHostEdit("solo");
        const checkbox = await $("[data-testid='host-modal-tunnel-enabled']");
        await checkbox.waitForExist({ timeout: 5_000 });
        expect(
            await checkbox.isEnabled(),
            "checkbox should be disabled with no candidate hosts",
        ).to.equal(false);
    });
});
