import { create } from "zustand";
import type { SavedHost, RecentConnection } from "../types";

interface HostsState {
  hosts: SavedHost[];
  loading: boolean;
  error: string | null;
  recentConnections: RecentConnection[];

  loadHosts: () => Promise<void>;
  saveHost: (host: SavedHost) => Promise<void>;
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
