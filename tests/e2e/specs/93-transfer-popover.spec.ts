// Issue #88 / PR #93: the transfer popover must not reopen on every progress
// event. The event listeners auto-opened the popover whenever an InProgress
// event arrived; since the backend emits one per chunk, dismissing the popover
// during an active upload reopened it immediately — impossible to close.
//
// The fix auto-opens only the first time a transfer id is seen. We drive the
// real listener (mounted globally in AppShell) with synthetic `sftp:transfer`
// events — exactly what the backend emits — so we can deterministically deliver
// many InProgress updates for the same transfer without a slow upload.

import { resetApp } from "../helpers/reset.js";
import { waitForDashboard } from "../helpers/dashboard.js";

const POPOVER = "[aria-label='Transfer items']";
const CLOSE_BTN = "[aria-label='Close transfers']";

interface TransferOverrides {
    transfer_id: string;
    status?: unknown;
    bytes_transferred?: number;
}

async function emitTransfer(o: TransferOverrides): Promise<void> {
    await browser.execute(async (over: TransferOverrides) => {
        const fn = (window as unknown as {
            __e2eEmitTransfer?: (event: string, payload: unknown) => Promise<void>;
        }).__e2eEmitTransfer;
        if (!fn) throw new Error("__e2eEmitTransfer not registered");
        await fn("sftp:transfer", {
            transfer_id: over.transfer_id,
            sftp_session_id: "sess-1",
            name: "big-file.bin",
            direction: "Upload",
            status: over.status ?? "InProgress",
            error: null,
            bytes_transferred: over.bytes_transferred ?? 1,
            total_bytes: 1_000_000,
            files_done: 0,
            files_total: 1,
            speed_bps: 1000,
            eta_secs: 60,
            created_at: 1_700_000_000,
        });
    }, o);
}

describe("Transfer popover — no reopen on progress (issue #88)", () => {
    beforeEach(async () => {
        await resetApp();
        await waitForDashboard();
    });

    it("stays closed after the user dismisses it during an active transfer", async () => {
        // Nothing in flight → popover is closed.
        await expect($(POPOVER)).not.toBeExisting();

        // First event for a new transfer → auto-opens.
        await emitTransfer({ transfer_id: "t1", bytes_transferred: 1 });
        await expect($(POPOVER)).toBeExisting();

        // User closes it.
        await (await $(CLOSE_BTN)).click();
        await expect($(POPOVER)).not.toBeExisting();

        // Further progress events for the SAME transfer must NOT reopen it.
        for (let i = 2; i <= 5; i++) {
            await emitTransfer({ transfer_id: "t1", bytes_transferred: i * 100_000 });
        }
        await browser.pause(800); // give any stray re-render time to happen
        await expect($(POPOVER)).not.toBeExisting();

        // A genuinely new transfer should still auto-open (feature intact).
        await emitTransfer({ transfer_id: "t2", bytes_transferred: 1 });
        await expect($(POPOVER)).toBeExisting();
    });
});
