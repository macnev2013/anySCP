import { create } from "zustand";
import type { HostHealthCheckResult } from "../types";

// UI-only superset of the backend `HostHealthStatus`: adds the local view
// states (`idle` before any check, `checking` while in flight, `error` for IPC
// failures) on top of the four backend outcomes.
export type HealthStatus =
  | "idle"
  | "checking"
  | "reachable"
  | "dnsFailed"
  | "portClosed"
  | "sshFailed"
  | "error";

export interface HostHealth {
  status: HealthStatus;
  message: string | null;
  latencyMs: number | null;
}

/** Stable reference for "no check run yet" so card selectors don't re-render. */
export const IDLE_HEALTH: HostHealth = { status: "idle", message: null, latencyMs: null };

interface HealthState {
  /** Last known health per host id. Lives in the store (not in HostCard) so it
   *  survives the dashboard unmounting when a terminal/other tab becomes active. */
  byHostId: Record<string, HostHealth>;
  checkHealth: (hostId: string) => Promise<void>;
}

export const useHealthStore = create<HealthState>((set, get) => ({
  byHostId: {},

  checkHealth: async (hostId) => {
    // In-flight guard: ignore re-triggers (button + context menu) while a check
    // for this host is already running. The store is the single source of truth,
    // so this can't be defeated by a stale React closure.
    if (get().byHostId[hostId]?.status === "checking") return;

    const setHealth = (h: HostHealth) =>
      set((s) => ({ byHostId: { ...s.byHostId, [hostId]: h } }));

    setHealth({ status: "checking", message: "Pinging host...", latencyMs: null });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const result = await invoke<HostHealthCheckResult>("ssh_health_check_saved_host", {
        hostId,
      });
      setHealth({ status: result.status, message: result.message, latencyMs: result.latencyMs });
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: string }).message)
          : "Ping failed";
      setHealth({ status: "error", message: msg, latencyMs: null });
    }
  },
}));
