import { create } from "zustand";
import type { SavedHost, RecentConnection } from "../types";

interface HostsState {
  hosts: SavedHost[];
  loading: boolean;
  error: string | null;
  recentConnections: RecentConnection[];

  loadHosts: () => Promise<void>;
  saveHost: (host: SavedHost) => Promise<void>;
  duplicateHost: (id: string) => Promise<void>;
  deleteHost: (id: string) => Promise<void>;
  loadRecent: () => Promise<void>;
  recordConnection: (hostId: string) => Promise<void>;
}

export const useHostsStore = create<HostsState>((set) => ({
  hosts: [],
  loading: false,
  error: null,
  recentConnections: [],

  loadHosts: async () => {
    set({ loading: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const hosts = await invoke<SavedHost[]>("list_hosts");
      set({ hosts });
    } catch (err: unknown) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Failed to load hosts";
      set({ error: msg });
    } finally {
      set({ loading: false });
    }
  },

  saveHost: async (host) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_host", { host });
    const hosts = await invoke<SavedHost[]>("list_hosts");
    set({ hosts });
  },

  duplicateHost: async (id) => {
    const { invoke } = await import("@tauri-apps/api/core");
    const hosts = await invoke<SavedHost[]>("list_hosts");
    const orig = hosts.find((h) => h.id === id);
    if (!orig) throw new Error(`host not found: ${id}`);
    const now = new Date().toISOString();
    const duplicate: SavedHost = {
      ...orig,
      id: crypto.randomUUID(),
      label: `${orig.label || orig.host} (copy)`,
      created_at: now,
      updated_at: now,
      last_connected_at: null,
      connection_count: null,
    };
    await invoke("save_host", { host: duplicate });
    const updated = await invoke<SavedHost[]>("list_hosts");
    set({ hosts: updated });
  },

  deleteHost: async (id) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_host", { id });
    const hosts = await invoke<SavedHost[]>("list_hosts");
    set({ hosts });
  },

  loadRecent: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const recentConnections = await invoke<RecentConnection[]>(
        "list_recent_connections",
        { limit: 10 },
      );
      set({ recentConnections });
    } catch {
      // Non-fatal — recent connections are best-effort
    }
  },

  recordConnection: async (hostId) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("record_connection", { hostId });
      // Reload recent list after recording
      const recentConnections = await invoke<RecentConnection[]>(
        "list_recent_connections",
        { limit: 10 },
      );
      set({ recentConnections });
    } catch {
      // Non-fatal
    }
  },
}));

// E2E test hook — lets WebDriver tests invoke duplicate without driving the
// right-click context menu (which is flaky in WebKitWebDriver). No production
// code reads this.
if (typeof window !== "undefined") {
  (window as unknown as { __e2eDuplicateHost?: (id: string) => Promise<void> })
    .__e2eDuplicateHost = (id) => useHostsStore.getState().duplicateHost(id);
}
