import { describe, it, expect, beforeEach } from "vitest";
import { useTransferStore } from "./transfer-store";
import type { TransferEvent, TransferStatusValue } from "../types";

const MAX_FINISHED_HISTORY = 200;

function event(id: string, status: TransferStatusValue): TransferEvent {
  return {
    transfer_id: id,
    sftp_session_id: "sess-1",
    name: `${id}.bin`,
    direction: "Upload",
    status,
    error: null,
    bytes_transferred: 0,
    total_bytes: 100,
    files_done: 0,
    files_total: 1,
    speed_bps: 0,
    eta_secs: null,
    created_at: 0,
  };
}

describe("transfer-store — finished history cap", () => {
  beforeEach(() => {
    useTransferStore.setState({ transfers: new Map(), finished_order: [] });
  });

  it("a repeated terminal event occupies a single history slot", () => {
    const { updateTransfer } = useTransferStore.getState();
    // Cancel racing the worker can emit the same terminal id twice.
    updateTransfer(event("t1", "Cancelled"));
    updateTransfer(event("t1", "Cancelled"));

    expect(useTransferStore.getState().finished_order).toEqual(["t1"]);
  });

  it("evicts the oldest finished transfer once the cap is exceeded", () => {
    const { updateTransfer } = useTransferStore.getState();
    for (let i = 0; i < MAX_FINISHED_HISTORY; i++) {
      updateTransfer(event(`t${i}`, "Completed"));
    }
    updateTransfer(event("overflow", "Completed"));

    const s = useTransferStore.getState();
    expect(s.finished_order.length).toBe(MAX_FINISHED_HISTORY);
    expect(s.transfers.has("t0")).toBe(false);
    expect(s.transfers.has("overflow")).toBe(true);
  });

  it("active transfers are never evicted by history trimming", () => {
    const { updateTransfer } = useTransferStore.getState();
    updateTransfer(event("active", "InProgress"));
    for (let i = 0; i <= MAX_FINISHED_HISTORY; i++) {
      updateTransfer(event(`t${i}`, "Completed"));
    }

    const s = useTransferStore.getState();
    expect(s.transfers.has("active")).toBe(true);
    expect(s.finished_order).not.toContain("active");
  });

  it("removeTransfer releases the history slot too", () => {
    const { updateTransfer, removeTransfer } = useTransferStore.getState();
    updateTransfer(event("t1", "Completed"));
    updateTransfer(event("t2", { Failed: "boom" }));
    removeTransfer("t1");

    const s = useTransferStore.getState();
    expect(s.transfers.has("t1")).toBe(false);
    expect(s.finished_order).toEqual(["t2"]);
  });

  it("clearFinished empties both the finished entries and the order", () => {
    const { updateTransfer, clearFinished } = useTransferStore.getState();
    updateTransfer(event("done", "Completed"));
    updateTransfer(event("active", "InProgress"));
    clearFinished();

    const s = useTransferStore.getState();
    expect(s.transfers.has("done")).toBe(false);
    expect(s.transfers.has("active")).toBe(true);
    expect(s.finished_order).toEqual([]);
  });
});
