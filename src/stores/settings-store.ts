import { create } from "zustand";

export type CursorStyle = "block" | "bar" | "underline";
export type ThemeMode = "dark" | "light";

interface SettingsState {
  // Appearance
  themeMode: ThemeMode;

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
  setThemeMode: (mode: ThemeMode) => void;
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
  themeMode: "dark" as ThemeMode,
  terminalFontSize: 14,
  terminalFontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
  terminalCursorStyle: "bar" as CursorStyle,
  terminalCursorBlink: true,
  terminalLineHeight: 1.2,
  terminalScrollback: 5000,
  transferConcurrency: 3,
};

/**
 * The Rust setup() hook injects the persisted theme onto <html> before the page
 * paints (see src-tauri/src/lib.rs). Seed the store from that attribute so the
 * initial render matches it — otherwise the default below would briefly override
 * the injected theme and re-introduce the startup flash. Falls back to the
 * default when the attribute is absent (e.g. a plain web/dev context).
 */
function initialThemeMode(): ThemeMode {
  if (typeof document !== "undefined" && document.documentElement.dataset.theme === "light") {
    return "light";
  }
  return DEFAULTS.themeMode;
}

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
  themeMode: initialThemeMode(),
  loaded: false,

  setThemeMode: (mode) => {
    set({ themeMode: mode });
    persist("app_theme", mode);
  },

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
          case "app_theme": updates.themeMode = value === "light" ? "light" : DEFAULTS.themeMode; break;
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
