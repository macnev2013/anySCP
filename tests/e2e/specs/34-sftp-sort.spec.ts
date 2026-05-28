// Sort order: click Name twice (descending), verify our two folders flip
// their positions. We pick names whose alphabetical order is well-defined
// regardless of the other directory contents.

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
    clickSortHeader,
    createFolder,
    deleteEntry,
    entryOrder,
    waitForExplorer,
} from "../helpers/sftp-ops.js";

const SSHD_PASS_HOST = process.env.SSHD_PASS_HOST ?? "sshd-pass";
const SSHD_PASS_PORT = Number(process.env.SSHD_PASS_PORT ?? 2222);
const SSH_USER = process.env.SSH_USER ?? "testuser";
const SSH_PASS = process.env.SSH_PASS ?? "testpass";

describe("SFTP sort", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("toggling Name sort reverses the order of two known entries", async () => {
        await openNewHostModal();
        await fillPasswordHostForm({
            label: "sort-target",
            host: SSHD_PASS_HOST,
            port: SSHD_PASS_PORT,
            username: SSH_USER,
            password: SSH_PASS,
        });
        await clickSave();
        await waitForModalClosed();
        await findHostCardByLabel("sort-target");

        const hostId = await getHostId("sort-target");
        await (await $(`[data-testid='host-card-${hostId}-explorer']`)).click();
        await waitForExplorer();

        const stamp = Date.now();
        const lower = `zzz-aaa-${stamp}`; // comes first alphabetically
        const upper = `zzz-bbb-${stamp}`; // comes after
        await createFolder(lower);
        await createFolder(upper);

        // Default sort is by Name ascending. Confirm lower < upper in listing.
        const ascOrder = await entryOrder();
        const ascA = ascOrder.indexOf(lower);
        const ascB = ascOrder.indexOf(upper);
        expect(ascA).to.be.lessThan(ascB);

        // Click the Name header to flip to descending.
        await clickSortHeader("name");

        await browser.waitUntil(
            async () => {
                const order = await entryOrder();
                return order.indexOf(lower) > order.indexOf(upper);
            },
            { timeout: 5_000, timeoutMsg: "Name sort order never flipped" },
        );

        // Cleanup so the test target doesn't accumulate stale entries.
        await clickSortHeader("name"); // flip back to ascending for deletion
        await deleteEntry(lower);
        await deleteEntry(upper);
    });
});
