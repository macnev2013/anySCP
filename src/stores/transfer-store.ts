import { create } from "zustand";
import type { TransferEvent, TransferStatusValue } from "../types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isFinished(status: TransferStatusValue): boolean {
  if (status === "Completed" || status === "Cancelled") return true;
  if (typeof status === "object" && "Failed" in status) return true;
  return false;
}

// ─── Store shape ──────────────────────────────────────────────────────────────

interface TransferState {
  transfers: Map<string, TransferEvent>;
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
  hostLabels: new Map(),
  popoverOpen: false,

  updateTransfer: (event) =>
    set((state) => {
      const next = new Map(state.transfers);
      next.set(event.transfer_id, event);
      return { transfers: next };
    }),

  removeTransfer: (id) =>
    set((state) => {
      const next = new Map(state.transfers);
      next.delete(id);
      return { transfers: next };
    }),

  clearFinished: () =>
    set((state) => {
      const next = new Map<string, TransferEvent>();
      for (const [id, transfer] of state.transfers) {
        if (!isFinished(transfer.status)) {
          next.set(id, transfer);
        }
      }
      return { transfers: next };
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
      return { transfers: next };
    }),

  setHostLabel: (sftpSessionId, label) =>
    set((state) => {
      if (state.hostLabels.get(sftpSessionId) === label) return state;
      const next = new Map(state.hostLabels);
      next.set(sftpSessionId, label);
      return { hostLabels: next };
    }),

  togglePopover: () =>
    set((state) => ({ popoverOpen: !state.popoverOpen })),

  setPopoverOpen: (open) =>
    set({ popoverOpen: open }),
}));
