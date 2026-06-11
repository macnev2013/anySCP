import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SavedHost } from "../types";
import { useHostsStore } from "./hosts-store";

// The store reaches the backend via a dynamic `import("@tauri-apps/api/core")`,
// so we mock that module's `invoke`. Each test swaps the implementation.
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

function makeHost(id: string, label: string): SavedHost {
  return {
    id,
    label,
    host: `${label}.example.com`,
    port: 22,
    username: "root",
    auth_type: "password",
    group_id: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    key_path: null,
    color: null,
    notes: null,
    environment: null,
    os_type: null,
    startup_command: null,
    proxy_jump: null,
    proxy_jump_host_id: null,
    start_directory: null,
    keep_alive_interval: null,
    default_shell: null,
    font_size: null,
    last_connected_at: null,
    connection_count: null,
  };
}

const a = makeHost("a", "alpha");
const b = makeHost("b", "bravo");
const c = makeHost("c", "charlie");

describe("hosts-store reorderHosts", () => {
  beforeEach(() => {
    invoke.mockReset();
    useHostsStore.setState({ hosts: [a, b, c], error: null });
  });

  it("optimistically applies the new order and persists the id list", async () => {
    invoke.mockResolvedValue(undefined);
    const newOrder = [c, a, b];

    await useHostsStore.getState().reorderHosts(newOrder);

    expect(useHostsStore.getState().hosts).toEqual(newOrder);
    expect(invoke).toHaveBeenCalledWith("reorder_hosts", {
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

    const promise = useHostsStore.getState().reorderHosts([b, c, a]);

    // Optimistic update is visible synchronously, while invoke is still pending.
    expect(useHostsStore.getState().hosts.map((h) => h.id)).toEqual(["b", "c", "a"]);

    resolveInvoke();
    await promise;
  });

  it("reverts to the previous order and rethrows when persistence fails", async () => {
    invoke.mockRejectedValue(new Error("db locked"));

    await expect(
      useHostsStore.getState().reorderHosts([c, b, a]),
    ).rejects.toThrow("db locked");

    // Order rolled back to the pre-drag state.
    expect(useHostsStore.getState().hosts).toEqual([a, b, c]);
  });
});
