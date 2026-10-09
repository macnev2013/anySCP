import { create } from "zustand";
import type { TransferEvent, TransferStatusValue } from "../types";

// Cap on retained finished-transfer history (prevents unbounded growth).
const MAX_FINISHED_HISTORY = 200;

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
  if (order.length <= MAX_FINISHED_HISTORY) {
    return { transfers, order };
  }
  const next = new Map(transfers);
  const nextOrder = order.slice();
  while (nextOrder.length > MAX_FINISHED_HISTORY) {
    const oldest = nextOrder.shift()!;
    const t = next.get(oldest);
    if (t && isFinished(t.status)) {
      next.delete(oldest);
    }
  }
  return { transfers: next, order: nextOrder };
}

// ─── Auto-open backoff ──────────────────────────────────────────────────────
// The popover auto-peeks when a transfer starts, but must not nag when you're
// manually copying lots of files: after each auto-open it suppresses re-opens
// for a window that doubles per open during a burst, resetting once things go
// quiet. (Module-level, not reactive — pure timing state.)
const AUTO_OPEN_BACKOFF_BASE_MS = 8_000;
const AUTO_OPEN_BACKOFF_MAX_MS = 60_000;
const AUTO_OPEN_QUIET_RESET_MS = 45_000;
let autoOpenSuppressUntil = 0;
let autoOpenBackoffMs = 0;
let lastAutoOpenAt = 0;

// ─── Store shape ──────────────────────────────────────────────────────────────

interface TransferState {
  transfers: Map<string, TransferEvent>;
  finished_order: string[];
  /** Maps sftp_session_id → host label. Persists after session closes. */
  hostLabels: Map<string, string>;
  popoverOpen: boolean;
  /** True when the popover was opened automatically (a transfer started) rather
   *  than by the user — only auto-opened popovers auto-dismiss when idle. */
  openedAuto: boolean;

  updateTransfer: (event: TransferEvent) => void;
  removeTransfer: (id: string) => void;
  clearFinished: () => void;
  hydrate: (items: TransferEvent[]) => void;
  setHostLabel: (sftpSessionId: string, label: string) => void;
  togglePopover: () => void;
  setPopoverOpen: (open: boolean) => void;
  /** Auto-peek on a new transfer, subject to the burst backoff above. */
  requestAutoOpen: () => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useTransferStore = create<TransferState>((set) => ({
  transfers: new Map(),
  finished_order: [],
  hostLabels: new Map(),
  popoverOpen: false,
  openedAuto: false,

  updateTransfer: (event) =>
    set((state) => {
      const next = new Map(state.transfers);
      next.set(event.transfer_id, event);

      if (!isFinished(event.status)) {
        return { transfers: next };
      }
      // A transfer can emit more than one terminal event (e.g. a cancel that
      // races the worker) — never let it occupy two history slots.
      if (state.finished_order.includes(event.transfer_id)) {
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

  // Manual open/close (icon click, pop-out, dismiss) — never auto-dismisses.
  togglePopover: () => set((state) => ({ popoverOpen: !state.popoverOpen, openedAuto: false })),

  setPopoverOpen: (open) => set({ popoverOpen: open, openedAuto: false }),

  requestAutoOpen: () =>
    set((state) => {
      if (state.popoverOpen) return state; // already visible → nothing to do
      const now = Date.now();
      if (now < autoOpenSuppressUntil) return state; // inside a backoff window
      // Grow the window each open during a burst; reset it after a quiet gap.
      autoOpenBackoffMs =
        now - lastAutoOpenAt > AUTO_OPEN_QUIET_RESET_MS
          ? AUTO_OPEN_BACKOFF_BASE_MS
          : Math.min(autoOpenBackoffMs * 2 || AUTO_OPEN_BACKOFF_BASE_MS, AUTO_OPEN_BACKOFF_MAX_MS);
      lastAutoOpenAt = now;
      autoOpenSuppressUntil = now + autoOpenBackoffMs;
      return { popoverOpen: true, openedAuto: true };
    }),
}));
