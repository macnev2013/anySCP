import { describe, it, expect } from "vitest";
import {
  classifyMoveOutcome,
  planMoveSources,
  reconcileFocusedId,
  CrossPaneMoveTracker,
  type PendingMove,
} from "./cross-pane-move";
import type { ExplorerEntry } from "../types/explorer";

function entry(id: string): ExplorerEntry {
  return {
    name: id.split("/").pop() ?? id,
    id,
    entryType: "File",
    size: 0,
    modified: null,
    permissionsDisplay: null,
    permissions: null,
    isSymlink: false,
    storageClass: null,
  };
}

describe("classifyMoveOutcome", () => {
  it("treats a bare 'Completed' string as completed", () => {
    expect(classifyMoveOutcome("Completed")).toBe("completed");
  });

  it("treats 'Cancelled' as a terminal failure (source stays)", () => {
    expect(classifyMoveOutcome("Cancelled")).toBe("failed");
  });

  it("treats the Failed(String) OBJECT form as a failure, not pending", () => {
    // The subtle one: Rust's `Failed(String)` serializes as `{ Failed: "…" }`,
    // never the string "Failed". Misreading it as pending would strand the
    // source; misreading it as completed would delete it.
    expect(classifyMoveOutcome({ Failed: "disk full" })).toBe("failed");
  });

  it("keeps in-flight statuses pending", () => {
    expect(classifyMoveOutcome("Queued")).toBe("pending");
    expect(classifyMoveOutcome("InProgress")).toBe("pending");
  });

  it("never completes on the literal string 'Failed' (which the wire never sends)", () => {
    // Guards against a regression that special-cased "Failed" as a string and so
    // failed to catch the real object form.
    expect(classifyMoveOutcome("Failed")).toBe("pending");
  });

  it("treats undefined/null as pending, not terminal", () => {
    expect(classifyMoveOutcome(undefined)).toBe("pending");
    expect(classifyMoveOutcome(null)).toBe("pending");
  });
});

describe("planMoveSources", () => {
  it("pairs each transfer id with its source entry in order", () => {
    const entries = [entry("/a.txt"), entry("/b.txt")];
    const plan = planMoveSources(["t1", "t2"], entries);
    expect(plan).not.toBeNull();
    expect(plan!.get("t1")).toBe(entries[0]);
    expect(plan!.get("t2")).toBe(entries[1]);
  });

  it("degrades to a copy (returns null) when the backend returns fewer ids", () => {
    // A partial enqueue can't be paired safely → no source is ever deleted.
    const entries = [entry("/a.txt"), entry("/b.txt")];
    expect(planMoveSources(["t1"], entries)).toBeNull();
  });

  it("degrades to a copy when the backend returns more ids than entries", () => {
    expect(planMoveSources(["t1", "t2"], [entry("/a.txt")])).toBeNull();
  });

  it("returns an empty plan for an empty transfer (no-op, not a mismatch)", () => {
    const plan = planMoveSources([], []);
    expect(plan).not.toBeNull();
    expect(plan!.size).toBe(0);
  });

  it("degrades to a copy when ids contain duplicates (can't pair 1:1)", () => {
    // A duplicate id would collapse two sources onto one key — one could never
    // be paired with a completion and would be silently retained. Bail instead.
    const entries = [entry("/a.txt"), entry("/b.txt")];
    expect(planMoveSources(["dup", "dup"], entries)).toBeNull();
  });
});

describe("reconcileFocusedId", () => {
  const local = "local:sess-1";
  const remote = "sess-1";

  it("keeps focus on the local pane when it still exists", () => {
    expect(reconcileFocusedId(local, local, remote)).toBe(local);
  });

  it("keeps focus on the remote pane when it still exists", () => {
    expect(reconcileFocusedId(remote, local, remote)).toBe(remote);
  });

  it("falls back to the remote pane after a session swap orphans the old id", () => {
    // sudo toggle: remoteId sess-1 → sess-2, so both pane ids change and the
    // stale focus matches neither.
    expect(reconcileFocusedId("local:sess-1", "local:sess-2", "sess-2")).toBe("sess-2");
  });
});

describe("CrossPaneMoveTracker", () => {
  const move = (id: string): PendingMove => ({ role: "local", entry: entry(id) });

  // The invariant this whole class exists to guarantee: a move's source is
  // deleted exactly once, iff its transfer COMPLETED — regardless of whether
  // the id is registered before or after the terminal event arrives.

  it("deletes the source when registration precedes completion (normal order)", () => {
    const t = new CrossPaneMoveTracker();
    const m = move("/a");
    expect(t.register("t1", m)).toEqual({ action: "await" });
    expect(t.terminal("t1", "completed")).toEqual({ action: "delete", move: m });
  });

  it("deletes the source when completion precedes registration (the RACE)", () => {
    // This is the ordering the earlier bug missed: a fast transfer emits
    // Completed before enqueue's invoke response registers the move. Without
    // the stash-and-reconcile, the delete would be lost and the move would
    // silently degrade to a copy. Here it must still delete.
    const t = new CrossPaneMoveTracker();
    const m = move("/a");
    expect(t.terminal("t1", "completed")).toEqual({ action: "stash", id: "t1" });
    expect(t.register("t1", m)).toEqual({ action: "delete", move: m });
  });

  it("keeps the source when it fails after registration", () => {
    const t = new CrossPaneMoveTracker();
    expect(t.register("t1", move("/a"))).toEqual({ action: "await" });
    expect(t.terminal("t1", "failed")).toEqual({ action: "keep" });
  });

  it("keeps the source when failure precedes registration", () => {
    const t = new CrossPaneMoveTracker();
    expect(t.terminal("t1", "failed")).toEqual({ action: "stash", id: "t1" });
    expect(t.register("t1", move("/a"))).toEqual({ action: "keep" });
  });

  it("does not delete twice on a repeated completion event", () => {
    const t = new CrossPaneMoveTracker();
    const m = move("/a");
    t.register("t1", m);
    expect(t.terminal("t1", "completed")).toEqual({ action: "delete", move: m });
    // A duplicate terminal (e.g. a racing re-emit) must not re-delete: the
    // pending entry is already consumed, so it can only stash (and expire).
    expect(t.terminal("t1", "completed")).toEqual({ action: "stash", id: "t1" });
  });

  it("does not delete once a stashed early outcome has expired", () => {
    // Documents the expiry-window tradeoff: if registration is delayed past the
    // caller's forgetEarly() backstop, the stash is gone and the source is left
    // in place (safe — never a wrong delete). The real gap is milliseconds.
    const t = new CrossPaneMoveTracker();
    expect(t.terminal("t1", "completed")).toEqual({ action: "stash", id: "t1" });
    t.forgetEarly("t1");
    expect(t.register("t1", move("/a"))).toEqual({ action: "await" });
  });

  it("tracks distinct transfer ids independently", () => {
    const t = new CrossPaneMoveTracker();
    const a = move("/a");
    const b = move("/b");
    t.register("t1", a);
    t.register("t2", b);
    // One completes, the other fails — each resolves to its own decision.
    expect(t.terminal("t2", "failed")).toEqual({ action: "keep" });
    expect(t.terminal("t1", "completed")).toEqual({ action: "delete", move: a });
  });
});
