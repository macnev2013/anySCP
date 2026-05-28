// Host search/filter — the dashboard's search box filters the host grid
// case-insensitively across label, host, and username.

import { expect } from "chai";
import { resetApp } from "../helpers/reset.js";
import { hostCardCount, waitForDashboard } from "../helpers/dashboard.js";
import {
    clickSave,
    fillPasswordHostForm,
    openNewHostModal,
    waitForModalClosed,
} from "../helpers/host.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

async function addHost(label: string): Promise<void> {
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
}

describe("host search", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("filters the host grid by label", async () => {
        await addHost("production-db");
        await addHost("staging-web");
        await addHost("local-dev");
        expect(await hostCardCount()).to.equal(3);

        const search = await $("[data-testid='host-search']");
        await search.click();
        await search.setValue("staging");

        await browser.waitUntil(async () => (await hostCardCount()) === 1, {
            timeout: 5_000,
            timeoutMsg: "filter never narrowed to 1 card",
        });
    });

    it("clears the filter when search is emptied", async () => {
        await addHost("alpha");
        await addHost("beta");

        const search = await $("[data-testid='host-search']");
        await search.click();
        await search.setValue("alpha");
        await browser.waitUntil(async () => (await hostCardCount()) === 1);

        // `clearValue()` sets `.value = ''` directly, which doesn't fire the
        // `input` event React's controlled <input> needs. Clear via keystrokes
        // so React's onChange runs and the filter state resets.
        await search.click();
        await browser.keys(["Control", "a"]);
        await browser.keys(["Backspace"]);

        await browser.waitUntil(async () => (await hostCardCount()) === 2, {
            timeout: 5_000,
        });
    });
});
