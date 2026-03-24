import { create } from "zustand";
import type { PortForwardRule, TunnelStatus } from "../types";

interface PortForwardState {
  rules: PortForwardRule[];
  activeTunnels: Map<string, TunnelStatus>;
  loading: boolean;

  loadRules: (hostId?: string) => Promise<void>;
  createRule: (params: Omit<PortForwardRule, "id" | "enabled" | "created_at">) => Promise<void>;
  updateRule: (rule: PortForwardRule) => Promise<void>;
  deleteRule: (id: string) => Promise<void>;
  startTunnel: (ruleId: string, hostId: string, rule: PortForwardRule) => Promise<void>;
  stopTunnel: (ruleId: string) => Promise<void>;
  updateTunnelStatus: (status: TunnelStatus) => void;
  loadActiveTunnels: () => Promise<void>;
}

export const usePortForwardStore = create<PortForwardState>((set, get) => ({
  rules: [],
  activeTunnels: new Map(),
  loading: false,

  loadRules: async (hostId) => {
    set({ loading: true });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const rules = await invoke<PortForwardRule[]>("pf_list_rules", {
        hostId: hostId ?? null,
      });
      set({ rules, loading: false });
    } catch {
      set({ loading: false });
    }
  },

  createRule: async (params) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<PortForwardRule>("pf_create_rule", {
        hostId: params.host_id,
        label: params.label,
        description: params.description,
        forwardType: params.forward_type,
        bindAddress: params.bind_address,
        localPort: params.local_port,
        remoteHost: params.remote_host,
        remotePort: params.remote_port,
        autoStart: params.auto_start,
      });
      await get().loadRules();
    } catch (err) {
      console.error("Create rule failed:", err);
    }
  },

  updateRule: async (rule) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("pf_update_rule", {
        id: rule.id,
        label: rule.label,
        description: rule.description,
        bindAddress: rule.bind_address,
        localPort: rule.local_port,
        remoteHost: rule.remote_host,
        remotePort: rule.remote_port,
        autoStart: rule.auto_start,
      });
      await get().loadRules();
    } catch (err) {
      console.error("Update rule failed:", err);
    }
  },

  deleteRule: async (id) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("pf_delete_rule", { id });
      set((state) => ({ rules: state.rules.filter((r) => r.id !== id) }));
    } catch (err) {
      console.error("Delete rule failed:", err);
    }
  },

  startTunnel: async (ruleId, hostId, rule) => {
    // Mark as starting immediately to prevent duplicate clicks
    set((state) => {
      const next = new Map(state.activeTunnels);
      next.set(ruleId, {
        rule_id: ruleId,
        status: "Starting",
        local_port: rule.local_port,
        connections: 0,
        error: null,
      });
      return { activeTunnels: next };
    });

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const status = await invoke<TunnelStatus>("pf_start_tunnel", {
        ruleId,
        hostId,
        bindAddress: rule.bind_address,
        localPort: rule.local_port,
        remoteHost: rule.remote_host,
        remotePort: rule.remote_port,
      });
      set((state) => {
        const next = new Map(state.activeTunnels);
        next.set(ruleId, status);
        return { activeTunnels: next };
      });
    } catch (err) {
      const msg = err && typeof err === "object" && "message" in err
        ? String((err as { message: string }).message)
        : typeof err === "string" ? err : "Tunnel failed to start";
      console.error("Start tunnel failed:", msg);
      set((state) => {
        const next = new Map(state.activeTunnels);
        next.set(ruleId, {
          rule_id: ruleId,
          status: "Error",
          local_port: rule.local_port,
          connections: 0,
          error: msg,
        });
        return { activeTunnels: next };
      });
    }
  },

  stopTunnel: async (ruleId) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("pf_stop_tunnel", { ruleId });
      set((state) => {
        const next = new Map(state.activeTunnels);
        next.delete(ruleId);
        return { activeTunnels: next };
      });
    } catch (err) {
      console.error("Stop tunnel failed:", err);
    }
  },

  updateTunnelStatus: (status) =>
    set((state) => {
      const next = new Map(state.activeTunnels);
      if (status.status === "Stopped") {
        next.delete(status.rule_id);
      } else {
        next.set(status.rule_id, status);
      }
      return { activeTunnels: next };
    }),

  loadActiveTunnels: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const tunnels = await invoke<TunnelStatus[]>("pf_list_active_tunnels");
      const map = new Map<string, TunnelStatus>();
      for (const t of tunnels) map.set(t.rule_id, t);
      set({ activeTunnels: map });
    } catch { /* best-effort */ }
  },
}));
