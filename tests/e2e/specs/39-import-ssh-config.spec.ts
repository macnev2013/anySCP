// Import SSH config: drop a config file at $HOME/.ssh/config, open the
// import modal (which auto-scans that path on mount), submit the import,
// verify hosts appear on the dashboard.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resetApp } from "../helpers/reset.js";
import { waitForDashboard, hostCardCount } from "../helpers/dashboard.js";
import { findHostCardByLabel } from "../helpers/host.js";

const SSH_CONFIG_DIR = join(homedir(), ".ssh");
const SSH_CONFIG_PATH = join(SSH_CONFIG_DIR, "config");

const FAKE_CONFIG = `
Host imported-alpha
  HostName 10.0.0.1
  User alice
  Port 2222

Host imported-beta
  HostName 10.0.0.2
  User bob
  Port 22
`;

describe("import SSH config", () => {
    beforeEach(async () => {
        // Seed the SSH config BEFORE relaunching the app so the modal's
        // auto-scan on mount finds it.
        await mkdir(SSH_CONFIG_DIR, { recursive: true });
        await writeFile(SSH_CONFIG_PATH, FAKE_CONFIG, "utf8");
        await resetApp();
        await waitForDashboard();
    });

    afterEach(async () => {
        // Clean up so subsequent runs don't inherit a stale config.
        await rm(SSH_CONFIG_PATH, { force: true });
    });

    it("scans the default config path and imports two hosts", async () => {
        const before = await hostCardCount();

        await (await $("[data-testid='import-ssh-config-button']")).click();

        // Submit button text reflects how many will import. Wait for it to
        // become enabled (scan complete + at least one selected).
        const submit = await $("[data-testid='import-ssh-config-submit']");
        await submit.waitForClickable({ timeout: 10_000 });
        await submit.click();

        // Both hosts should land on the dashboard (HostCard displayName uses
        // host.label || host.host; the importer stores `host_alias` as the label).
        await findHostCardByLabel("imported-alpha");
        await findHostCardByLabel("imported-beta");

        // Two new cards beyond whatever was there before.
        await browser.waitUntil(
            async () => (await hostCardCount()) >= before + 2,
            { timeout: 10_000, timeoutMsg: "imported hosts didn't appear on dashboard" },
        );
    });
});
