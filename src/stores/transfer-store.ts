import { create } from "zustand";
import type { TransferEvent, TransferStatusValue } from "../types";

/// Fix infinite history
const MAX_FINISHED_HOSTORY = 200;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isFinished(status: TransferStatusValue): boolean {
  if (status === "Completed" || status === "Cancelled") return true;
  if (typeof status === "object" && "Failed" in status) return true;
  return false;
}

function trimFinished(
  transfers: Map<string, TransferEvent>,
  order: string[],
): { transfers: Map<string, TransferEvent>; order: string[] } {
  if (order.length <= MAX_FINISHED_HOSTORY) {
    return { transfers, order };
  }
  const next = new Map(transfers);
  const nextOrder = order.slice();
  while (nextOrder.length > MAX_FINISHED_HOSTORY) {
    const oldest = nextOrder.shift()!;
    const t = next.get(oldest);
    if (t && isFinished(t.status)) {
      next.delete(oldest);
    }
  }
  return { transfers: next, order: nextOrder };
}

// ─── Store shape ──────────────────────────────────────────────────────────────

interface TransferState {
  transfers: Map<string, TransferEvent>;
  finished_order: string[];
  /** Maps sftp_session_id → host label. Persists after session closes. */
  hostLabels: Map<string, string>;
  popoverOpen: boolean;

  updateTransfer: (event: TransferEvent) => void;
  removeTransfer: (id: string) => void;
  clearFinished: () => void;
  hydrate: (items: TransferEvent[]) => void;
  setHostLabel: (sftpSessionId: string, label: string) => void;
  togglePopover: () => void;
  setPopoverOpen: (open: boolean) => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useTransferStore = create<TransferState>((set) => ({
  transfers: new Map(),
  finished_order: [],
  hostLabels: new Map(),
  popoverOpen: false,

  updateTransfer: (event) =>
    set((state) => {
      const next = new Map(state.transfers);
      next.set(event.transfer_id, event);

      if (!isFinished(event.status)) {
        return { transfers: next };
      }
      const order = [...state.finished_order, event.transfer_id];
      const trimmed = trimFinished(next, order);
      return { transfers: trimmed.transfers, finished_order: trimmed.order };
    }),

  removeTransfer: (id) =>
    set((state) => {
      const next = new Map(state.transfers);
      next.delete(id);
      return {
        transfers: next,
        finished_order: state.finished_order.filter((fid) => fid !== id),
      };
    }),

  clearFinished: () =>
    set((state) => {
      const next = new Map<string, TransferEvent>();
      for (const [id, transfer] of state.transfers) {
        if (!isFinished(transfer.status)) {
          next.set(id, transfer);
        }
      }
      return { transfers: next, finished_order: [] };
    }),

  hydrate: (items) =>
    set((state) => {
      // Merge: backend snapshot fills in anything missing, but live events
      // that arrived before hydration take precedence (they are more recent).
      const next = new Map<string, TransferEvent>();
      for (const item of items) {
        next.set(item.transfer_id, item);
      }
      // Overlay any events that arrived via the live listener before hydrate ran
      for (const [id, transfer] of state.transfers) {
        next.set(id, transfer);
      }

      const seen = new Set(state.finished_order);
      const order = [...state.finished_order];
      for (const item of items) {
        if (isFinished(item.status) && !seen.has(item.transfer_id)) {
          order.push(item.transfer_id);
          seen.add(item.transfer_id);
        }
      }
      const trimmed = trimFinished(next, order);
      return {
        transfers: trimmed.transfers,
        finished_order: trimmed.order,
      };
    }),

  setHostLabel: (sftpSessionId, label) =>
    set((state) => {
      if (state.hostLabels.get(sftpSessionId) === label) return state;
      const next = new Map(state.hostLabels);
      next.set(sftpSessionId, label);
      return { hostLabels: next };
    }),

  togglePopover: () => set((state) => ({ popoverOpen: !state.popoverOpen })),

  setPopoverOpen: (open) => set({ popoverOpen: open }),
}));
