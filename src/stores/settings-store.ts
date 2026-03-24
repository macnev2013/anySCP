import { create } from "zustand";

export type CursorStyle = "block" | "bar" | "underline";

interface SettingsState {
  // Terminal appearance
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalCursorStyle: CursorStyle;
  terminalCursorBlink: boolean;
  terminalLineHeight: number;
  terminalScrollback: number;

  // Transfers
  transferConcurrency: number;

  // State
  loaded: boolean;

  // Actions
  setTerminalFontSize: (size: number) => void;
  setTerminalFontFamily: (family: string) => void;
  setTerminalCursorStyle: (style: CursorStyle) => void;
  setTerminalCursorBlink: (blink: boolean) => void;
  setTerminalLineHeight: (height: number) => void;
  setTerminalScrollback: (lines: number) => void;
  setTransferConcurrency: (n: number) => void;
  loadSettings: () => Promise<void>;
}

// Defaults
const DEFAULTS = {
  terminalFontSize: 14,
  terminalFontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
  terminalCursorStyle: "bar" as CursorStyle,
  terminalCursorBlink: true,
  terminalLineHeight: 1.2,
  terminalScrollback: 5000,
  transferConcurrency: 3,
};

/** Persist a single setting to the backend. Fire-and-forget. */
function persist(key: string, value: string) {
  void (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_setting", { key, value });
    } catch { /* best-effort */ }
  })();
}

export const useSettingsStore = create<SettingsState>((set) => ({
  ...DEFAULTS,
  loaded: false,

  setTerminalFontSize: (size) => {
    const clamped = Math.max(8, Math.min(32, size));
    set({ terminalFontSize: clamped });
    persist("terminal_font_size", String(clamped));
  },

  setTerminalFontFamily: (family) => {
    set({ terminalFontFamily: family });
    persist("terminal_font_family", family);
  },

  setTerminalCursorStyle: (style) => {
    set({ terminalCursorStyle: style });
    persist("terminal_cursor_style", style);
  },

  setTerminalCursorBlink: (blink) => {
    set({ terminalCursorBlink: blink });
    persist("terminal_cursor_blink", String(blink));
  },

  setTerminalLineHeight: (height) => {
    const clamped = Math.max(1.0, Math.min(2.0, height));
    set({ terminalLineHeight: clamped });
    persist("terminal_line_height", String(clamped));
  },

  setTerminalScrollback: (lines) => {
    const clamped = Math.max(500, Math.min(100000, lines));
    set({ terminalScrollback: clamped });
    persist("terminal_scrollback", String(clamped));
  },

  setTransferConcurrency: (n) => {
    const clamped = Math.max(1, Math.min(10, n));
    set({ transferConcurrency: clamped });
    persist("transfer_concurrency", String(clamped));
    // Also update the backend transfer manager
    void (async () => {
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("sftp_set_concurrency", { maxConcurrent: clamped });
      } catch { /* best-effort */ }
    })();
  },

  loadSettings: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const pairs = await invoke<[string, string][]>("load_all_settings");

      const updates: Partial<SettingsState> = {};
      for (const [key, value] of pairs) {
        switch (key) {
          case "terminal_font_size": updates.terminalFontSize = Number(value) || DEFAULTS.terminalFontSize; break;
          case "terminal_font_family": updates.terminalFontFamily = value || DEFAULTS.terminalFontFamily; break;
          case "terminal_cursor_style": updates.terminalCursorStyle = (value as CursorStyle) || DEFAULTS.terminalCursorStyle; break;
          case "terminal_cursor_blink": updates.terminalCursorBlink = value !== "false"; break;
          case "terminal_line_height": updates.terminalLineHeight = Number(value) || DEFAULTS.terminalLineHeight; break;
          case "terminal_scrollback": updates.terminalScrollback = Number(value) || DEFAULTS.terminalScrollback; break;
          case "transfer_concurrency": updates.transferConcurrency = Number(value) || DEFAULTS.transferConcurrency; break;
        }
      }

      set({ ...updates, loaded: true });
    } catch {
      set({ loaded: true }); // Use defaults if backend unavailable
    }
  },
}));
