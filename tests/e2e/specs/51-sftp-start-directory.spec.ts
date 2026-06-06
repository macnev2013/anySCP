// A host's `start_directory` sets the folder the file browser opens in,
// instead of the default home directory. Set it to an absolute path that is
// guaranteed to exist on the server (/etc, which holds a world-readable
// `passwd`) and assert the explorer lands there on connect.

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
import { waitForEntry, waitForExplorer } from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("SFTP start directory", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("opens the file browser in the host's configured start directory", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "start-dir-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });

        // Set the start directory via its dedicated testid.
        const startDir = await $("[data-testid='host-modal-start-directory']");
        await startDir.click();
        await startDir.setValue("/etc");

        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("start-dir-target");

        const hostId = await getHostId("start-dir-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        // /etc/passwd is world-readable on the test server — its presence in
        // the listing proves the explorer opened in /etc rather than home.
        const passwd = await waitForEntry("passwd");
        expect(await passwd.isExisting()).to.equal(true);

        // The breadcrumb's last segment must be "etc", not the home basename.
        const lastSegment = await browser.execute(() => {
            const buttons = Array.from(
                document.querySelectorAll<HTMLButtonElement>(
                    "[aria-label='Current path'] button",
                ),
            );
            return buttons.at(-1)?.textContent ?? "";
        });
        expect(lastSegment).to.equal("etc");
    });
});
