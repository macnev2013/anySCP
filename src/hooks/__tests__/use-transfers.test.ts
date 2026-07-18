import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTransfers } from "../use-transfers";
import { useTransferStore } from "../../stores/transfer-store";
import type { TransferEvent } from "../../types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function transfer(over: Partial<TransferEvent>): TransferEvent {
  return {
    transfer_id: "t1",
    sftp_session_id: "sess-1",
    name: "file.txt",
    direction: "Upload",
    status: "Queued",
    error: null,
    bytes_transferred: 0,
    total_bytes: 100,
    files_done: 0,
    files_total: 1,
    speed_bps: 0,
    eta_secs: null,
    created_at: 0,
    ...over,
  };
}

function seed(...items: TransferEvent[]) {
  useTransferStore.setState({
    transfers: new Map(items.map((t) => [t.transfer_id, t])),
  });
}

describe("useTransfers", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    useTransferStore.setState({ transfers: new Map() });
  });

  it("sorts active first, then queued, then finished, and counts each bucket", () => {
    seed(
      transfer({ transfer_id: "done", status: "Completed" }),
      transfer({ transfer_id: "queued", status: "Queued" }),
      transfer({ transfer_id: "active", status: "InProgress" }),
      transfer({ transfer_id: "failed", status: { Failed: "boom" } }),
    );
    const { result } = renderHook(() => useTransfers());

    expect(result.current.list.map((t) => t.transfer_id)).toEqual([
      "active",
      "queued",
      "done",
      "failed",
    ]);
    expect(result.current.activeCount).toBe(1);
    expect(result.current.queuedCount).toBe(1);
    expect(result.current.finishedCount).toBe(2);
  });

  it("routes cancel and retry to the backend owning the transfer", async () => {
    seed(
      transfer({ transfer_id: "sftp-t", sftp_session_id: "s1" }),
      transfer({ transfer_id: "scp-t", sftp_session_id: undefined, scp_session_id: "s2" }),
      transfer({ transfer_id: "s3-t", sftp_session_id: undefined, s3_session_id: "s3" }),
    );
    const { result } = renderHook(() => useTransfers());

    // Sequential on purpose: firing these in one tick makes the hook's
    // dynamic `import("@tauri-apps/api/core")` calls race, and vitest's mock
    // runner resolves the losers to an undefined namespace (test-env quirk;
    // browsers cache module namespaces so the app is unaffected).
    result.current.onCancel("sftp-t");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    result.current.onCancel("scp-t");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    result.current.onRetry("s3-t");
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));

    expect(invoke).toHaveBeenCalledWith("sftp_cancel_transfer", { transferId: "sftp-t" });
    expect(invoke).toHaveBeenCalledWith("scp_cancel_transfer", { transferId: "scp-t" });
    expect(invoke).toHaveBeenCalledWith("s3_retry_transfer", { transferId: "s3-t" });
  });

  it("drops the row locally when cancel fails on the backend", async () => {
    seed(transfer({ transfer_id: "gone" }));
    invoke.mockRejectedValue(new Error("no such transfer"));
    const { result } = renderHook(() => useTransfers());

    result.current.onCancel("gone");

    await vi.waitFor(() =>
      expect(useTransferStore.getState().transfers.has("gone")).toBe(false),
    );
  });

  it("clear-finished empties the store buckets and notifies every backend", async () => {
    seed(
      transfer({ transfer_id: "done", status: "Completed" }),
      transfer({ transfer_id: "active", status: "InProgress" }),
    );
    const { result } = renderHook(() => useTransfers());

    act(() => result.current.onClearFinished());

    expect(useTransferStore.getState().transfers.has("done")).toBe(false);
    expect(useTransferStore.getState().transfers.has("active")).toBe(true);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    expect(invoke).toHaveBeenCalledWith("sftp_clear_finished_transfers");
    expect(invoke).toHaveBeenCalledWith("scp_clear_finished_transfers");
    expect(invoke).toHaveBeenCalledWith("s3_clear_finished_transfers");
  });

  it("keeps row-callback identities stable across progress ticks", () => {
    seed(transfer({ transfer_id: "t1", status: "InProgress" }));
    const { result, rerender } = renderHook(() => useTransfers());
    const before = {
      onCancel: result.current.onCancel,
      onRetry: result.current.onRetry,
      onDismiss: result.current.onDismiss,
    };

    // A progress tick replaces the transfers map — the memoized rows must not
    // see new callbacks or every row re-renders on every tick.
    act(() => {
      useTransferStore
        .getState()
        .updateTransfer(transfer({ transfer_id: "t1", status: "InProgress", bytes_transferred: 50 }));
    });
    rerender();

    expect(result.current.onCancel).toBe(before.onCancel);
    expect(result.current.onRetry).toBe(before.onRetry);
    expect(result.current.onDismiss).toBe(before.onDismiss);
  });
});
