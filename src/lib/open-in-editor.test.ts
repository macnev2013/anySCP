// Issue #141: opening a large remote file in an editor gave no sign anything
// was happening, and a second double-click downloaded and opened it again.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { openInEditorWithProgress, OPEN_PROGRESS_DELAY_MS } from "./open-in-editor";
import { useToastStore } from "../stores/toast-store";

/** A download we finish by hand, to hold the "opening" state open. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const toasts = () => useToastStore.getState().toasts;

describe("openInEditorWithProgress", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a progress toast while a slow download runs, then clears it", async () => {
    const dl = deferred();
    const done = openInEditorWithProgress("s\0/var/log/big.log", "big.log", () => dl.promise);

    await vi.advanceTimersByTimeAsync(OPEN_PROGRESS_DELAY_MS);
    expect(toasts()).toEqual([
      expect.objectContaining({ kind: "progress", message: 'Downloading "big.log" to open…' }),
    ]);

    // Progress toasts don't auto-dismiss — a big file can take minutes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(toasts()).toHaveLength(1);

    dl.resolve();
    await done;
    expect(toasts()).toEqual([]);
  });

  it("skips the toast for a file that opens quickly", async () => {
    await openInEditorWithProgress("s\0/etc/hosts", "hosts", async () => {});
    await vi.advanceTimersByTimeAsync(OPEN_PROGRESS_DELAY_MS * 2);
    expect(toasts()).toEqual([]);
  });

  it("ignores a second open of the same file while the first is in flight", async () => {
    const dl = deferred();
    const open = vi.fn(() => dl.promise);

    const first = openInEditorWithProgress("s\0/a/big.iso", "big.iso", open);
    await openInEditorWithProgress("s\0/a/big.iso", "big.iso", open);

    expect(open).toHaveBeenCalledTimes(1);
    expect(toasts()).toEqual([
      expect.objectContaining({ kind: "info", message: '"big.iso" is already opening…' }),
    ]);

    dl.resolve();
    await first;

    // Once finished, opening it again works normally.
    await openInEditorWithProgress("s\0/a/big.iso", "big.iso", open);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does not block a different file, or the same path in another session", async () => {
    const dl = deferred();
    const open = vi.fn(() => dl.promise);

    const a = openInEditorWithProgress("s1\0/a.txt", "a.txt", open);
    const b = openInEditorWithProgress("s1\0/b.txt", "b.txt", open);
    const c = openInEditorWithProgress("s2\0/a.txt", "a.txt", open);
    expect(open).toHaveBeenCalledTimes(3);

    dl.resolve();
    await Promise.all([a, b, c]);
  });

  it("replaces the progress toast with the error when opening fails, and frees the file", async () => {
    const dl = deferred();
    const done = openInEditorWithProgress("s\0/x.bin", "x.bin", () => dl.promise);
    await vi.advanceTimersByTimeAsync(OPEN_PROGRESS_DELAY_MS);

    dl.reject({ kind: "RemoteIoError", message: "Permission denied" });
    await done;

    expect(toasts()).toEqual([
      expect.objectContaining({ kind: "error", message: "Permission denied" }),
    ]);

    const retry = vi.fn(async () => {});
    await openInEditorWithProgress("s\0/x.bin", "x.bin", retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
