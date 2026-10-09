import type { ExplorerEntry } from "../types/explorer";

/**
 * Terminal disposition of a cross-pane transfer, as far as a MOVE cares. A move
 * deletes its source only on `completed`; `failed` drops the pending deletion
 * (never lose data); `pending` leaves it in place to await a later event.
 */
export type MoveOutcome = "completed" | "failed" | "pending";

/**
 * Classify a raw transfer `status` from a `*:transfer` event payload.
 *
 * The Rust unit variants (`Completed`, `Cancelled`, …) serialize as bare
 * strings, but `Failed(String)` serializes as an OBJECT — `{ "Failed": "…" }` —
 * not the string `"Failed"`. Treating any non-null object as a terminal failure
 * is what stops a failed transfer from being mistaken for still-pending (which
 * would strand the source) or, worse, for completed (which would delete it).
 */
export function classifyMoveOutcome(status: unknown): MoveOutcome {
  if (status === "Completed") return "completed";
  if (status === "Cancelled") return "failed";
  if (typeof status === "object" && status !== null) return "failed";
  return "pending";
}

/**
 * Map queued transfer ids to the sources a MOVE should delete once each lands.
 *
 * `enqueue` preserves order, so `ids[i]` is the transfer for `entries[i]`. If
 * the backend returns a different count we can't pair them safely, so we return
 * `null`: the caller records no pending deletions and the move degrades to a
 * copy — never a wrong delete.
 */
export function planMoveSources<T>(ids: string[], entries: T[]): Map<string, T> | null {
  if (ids.length !== entries.length) return null;
  const plan = new Map<string, T>();
  ids.forEach((id, i) => plan.set(id, entries[i]));
  // Duplicate ids would collapse two sources onto one key, so one source could
  // never be paired with a completion → silently retained. Can't happen with
  // fresh uuids, but bail to a copy rather than risk a half-done move.
  if (plan.size !== ids.length) return null;
  return plan;
}

/** The value a coordinator tracks per pending move: which pane owns the source. */
export interface PendingMove {
  role: "local" | "remote";
  entry: ExplorerEntry;
}

/** What the coordinator should do with a move's source after a reconcile step. */
export type MoveDecision =
  | { action: "delete"; move: PendingMove } // transfer completed — delete the source now
  | { action: "keep" } // failed/cancelled resolved — leave the source, nothing to schedule
  | { action: "await" } // registered; waiting for the terminal event
  | { action: "stash"; id: string }; // terminal seen before registration — schedule expiry

/**
 * Reconciles the two signals of a cross-pane MOVE, which can arrive in EITHER
 * order, into a single "delete the source or not" decision:
 *   - `register(id, move)` — the move's transfer id became known (`onEnqueued`).
 *   - `terminal(id, outcome)` — the transfer reached a terminal state (event).
 *
 * Invariant, independent of arrival order: a move's source is deleted exactly
 * once, iff its transfer COMPLETED; a failed/cancelled transfer never deletes
 * it. The order isn't guaranteed — for a small/fast transfer the worker can emit
 * its completion event BEFORE `enqueue_upload`'s invoke response resolves and
 * registers the move — so a terminal seen with no registration is stashed for a
 * late `register` (the caller expires the stash so unrelated transfers can't
 * accumulate). Decision only; the caller performs the delete and the expiry.
 */
export class CrossPaneMoveTracker {
  private readonly pending = new Map<string, PendingMove>();
  private readonly early = new Map<string, "completed" | "failed">();

  /** The move's transfer id is now known. Returns whether to delete already. */
  register(id: string, move: PendingMove): MoveDecision {
    const early = this.early.get(id);
    if (early !== undefined) {
      this.early.delete(id);
      return early === "completed" ? { action: "delete", move } : { action: "keep" };
    }
    this.pending.set(id, move);
    return { action: "await" };
  }

  /** A transfer reached a terminal state. Returns whether to delete its source. */
  terminal(id: string, outcome: "completed" | "failed"): MoveDecision {
    const move = this.pending.get(id);
    if (move !== undefined) {
      this.pending.delete(id);
      return outcome === "completed" ? { action: "delete", move } : { action: "keep" };
    }
    // Terminal before registration — stash so a late register() can reconcile.
    this.early.set(id, outcome);
    return { action: "stash", id };
  }

  /** Drop a stashed early outcome (self-expiry backstop against growth). */
  forgetEarly(id: string): void {
    this.early.delete(id);
  }
}

/**
 * Reconcile the focused pane id after a session swap (e.g. the sudo toggle),
 * which changes `remoteId` and, with it, both pane ids. Keep the current focus
 * if it still names a live pane; otherwise fall back to the remote pane. Without
 * this, a `focusedId` seeded from the pre-swap id would match neither pane and
 * the dual-pane highlight/keyboard target would be lost.
 */
export function reconcileFocusedId(current: string, localKey: string, remoteId: string): string {
  return current === localKey || current === remoteId ? current : remoteId;
}
