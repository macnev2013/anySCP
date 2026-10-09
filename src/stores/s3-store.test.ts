import { describe, it, expect, beforeEach, vi } from "vitest";
import type { S3Connection, S3Entry } from "../types";
import { useS3Store } from "./s3-store";

// The store reaches the backend via a dynamic `import("@tauri-apps/api/core")`,
// so we mock that module's `invoke`. Each test swaps the implementation.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function makeConn(id: string, label: string): S3Connection {
  return {
    id,
    label,
    provider: "aws",
    region: "us-east-1",
    endpoint: null,
    bucket: "my-bucket",
    path_style: false,
    group_id: null,
    color: null,
    environment: null,
    notes: null,
    created_at: "2024-01-01T00:00:00Z",
  };
}

const a = makeConn("a", "alpha");
const b = makeConn("b", "bravo");
const c = makeConn("c", "charlie");

describe("s3-store reorderConnections", () => {
  beforeEach(() => {
    invoke.mockReset();
    useS3Store.setState({ connections: [a, b, c] });
  });

  it("optimistically applies the new order and persists the id list", async () => {
    invoke.mockResolvedValue(undefined);
    const newOrder = [c, a, b];

    await useS3Store.getState().reorderConnections(newOrder);

    expect(useS3Store.getState().connections).toEqual(newOrder);
    expect(invoke).toHaveBeenCalledWith("reorder_s3_connections", {
      orderedIds: ["c", "a", "b"],
    });
  });

  it("applies the new order immediately, before the backend resolves", async () => {
    let resolveInvoke: () => void = () => {};
    invoke.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInvoke = resolve;
      }),
    );

    const promise = useS3Store.getState().reorderConnections([b, c, a]);

    // Optimistic update is visible synchronously, while invoke is still pending.
    expect(useS3Store.getState().connections.map((conn) => conn.id)).toEqual(["b", "c", "a"]);

    resolveInvoke();
    await promise;
  });

  it("reverts to the previous order and rethrows when persistence fails", async () => {
    invoke.mockRejectedValue(new Error("db locked"));

    await expect(
      useS3Store.getState().reorderConnections([c, b, a]),
    ).rejects.toThrow("db locked");

    // Order rolled back to the pre-drag state.
    expect(useS3Store.getState().connections).toEqual([a, b, c]);
  });
});

function makeEntry(name: string): S3Entry {
  return { name, key: name, entry_type: "File", size: 0, last_modified: null, storage_class: null };
}

describe("s3-store paged listings", () => {
  beforeEach(() => {
    useS3Store.setState({ sessions: new Map() });
    useS3Store.getState().openSession("s1", "test");
  });

  it("appends a further page and advances the token", () => {
    const store = useS3Store.getState();
    store.setEntries("s1", "logs/", [makeEntry("a")], "tok-1");
    store.appendEntries("s1", "logs/", [makeEntry("b")], null);

    const session = useS3Store.getState().sessions.get("s1")!;
    expect(session.entries.map((e) => e.name)).toEqual(["a", "b"]);
    expect(session.nextToken).toBeNull();
  });

  it("drops a page that arrives after navigating to another prefix", () => {
    const store = useS3Store.getState();
    store.setEntries("s1", "logs/", [makeEntry("a")], "tok-1");
    store.setEntries("s1", "other/", [makeEntry("x")]);
    store.appendEntries("s1", "logs/", [makeEntry("b")], "tok-2");

    const session = useS3Store.getState().sessions.get("s1")!;
    expect(session.entries.map((e) => e.name)).toEqual(["x"]);
    expect(session.nextToken).toBeNull();
  });
});
