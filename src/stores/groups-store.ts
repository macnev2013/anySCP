import { create } from "zustand";
import type { HostGroup } from "../types";

interface GroupsState {
  groups: HostGroup[];
  loading: boolean;
  error: string | null;

  loadGroups: () => Promise<void>;
  createGroup: (group: HostGroup) => Promise<void>;
  updateGroup: (group: HostGroup) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
}

export const useGroupsStore = create<GroupsState>((set) => ({
  groups: [],
  loading: false,
  error: null,

  loadGroups: async () => {
    set({ loading: true, error: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const groups = await invoke<HostGroup[]>("list_groups");
      set({ groups });
    } catch (err: unknown) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Failed to load groups";
      set({ error: msg });
    } finally {
      set({ loading: false });
    }
  },

  createGroup: async (group) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("create_group", { group });
    const groups = await invoke<HostGroup[]>("list_groups");
    set({ groups });
  },

  updateGroup: async (group) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("update_group", { group });
    const groups = await invoke<HostGroup[]>("list_groups");
    set({ groups });
  },

  deleteGroup: async (id) => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("delete_group", { id });
    const groups = await invoke<HostGroup[]>("list_groups");
    set({ groups });
  },
}));
