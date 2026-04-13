import { create } from "zustand";
import type {
  RdpSessionId,
  RdpConfig,
  RdpConnectionStatus,
  RdpSession,
} from "../types";

interface RdpState {
  sessions: Map<RdpSessionId, RdpSession>;
  activeRdpSessionId: RdpSessionId | null;

  addSession: (id: RdpSessionId, config: RdpConfig, wsPort: number) => void;
  removeSession: (id: RdpSessionId) => void;
  setActiveRdpSession: (id: RdpSessionId | null) => void;
  updateStatus: (
    id: RdpSessionId,
    status: RdpConnectionStatus,
    message?: string,
  ) => void;
}

export const useRdpStore = create<RdpState>((set) => ({
  sessions: new Map(),
  activeRdpSessionId: null,

  addSession: (id, config, wsPort) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.set(id, {
        id,
        config,
        status: "Connected",
        label: `${config.username}@${config.host}`,
        wsPort,
      });
      return { sessions, activeRdpSessionId: id };
    }),

  removeSession: (id) =>
    set((state) => {
      const sessions = new Map(state.sessions);
      sessions.delete(id);
      return {
        sessions,
        activeRdpSessionId: state.activeRdpSessionId === id ? null : state.activeRdpSessionId,
      };
    }),

  setActiveRdpSession: (id) => set({ activeRdpSessionId: id }),

  updateStatus: (id, status, message) =>
    set((state) => {
      const session = state.sessions.get(id);
      if (!session) return state;
      const sessions = new Map(state.sessions);
      sessions.set(id, { ...session, status, statusMessage: message });
      return { sessions };
    }),
}));
