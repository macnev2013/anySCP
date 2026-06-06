// When the new-host and new-S3 dialogs open, focus should land on their first
// input (the Label field) so the user can start typing immediately.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";
import { openNewHostModal } from "../helpers/host.js";
import { openNewS3Dialog } from "../helpers/s3.js";

/** Wait until the focused element carries the given data-testid. */
async function waitForFocusedTestId(testid: string): Promise<void> {
    await browser.waitUntil(
        async () =>
            (await browser.execute(
                () => document.activeElement?.getAttribute("data-testid") ?? "",
            )) === testid,
        { timeout: 5_000, timeoutMsg: `focus never landed on '${testid}'` },
    );
}

describe("dialog focuses first input on open", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("focuses the Label field when the new-host dialog opens", async () => {
        await openNewHostModal();
        await waitForFocusedTestId("host-modal-label");
    });

    it("focuses the Label field when the new-S3 dialog opens", async () => {
        await openNewS3Dialog();
        await waitForFocusedTestId("s3-dialog-label");
    });
});
