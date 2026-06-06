import { create } from "zustand";

export type CursorStyle = "block" | "bar" | "underline";
export type ThemeMode = "dark" | "light";

/** Full custom accent colour in oklch components (lightness, chroma, hue). */
export interface AccentCustom { l: number; c: number; h: number }

interface SettingsState {
  // Appearance
  themeMode: ThemeMode;
  accentHue: number;
  accentCustom: AccentCustom | null;
  interfaceFont: string;

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
  setAccentHue: (hue: number) => void;
  setAccentCustom: (custom: AccentCustom | null) => void;
  setInterfaceFont: (font: string) => void;
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
  accentHue: 250,
  accentCustom: null as AccentCustom | null,
  interfaceFont: "'Geist', system-ui, sans-serif",
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

/**
 * Seed the accent hue from the --accent-hue CSS variable injected by the Rust
 * setup() hook before first paint (mirrors initialThemeMode), so the initial
 * render matches the persisted accent and there's no flash. Falls back to the
 * default when absent.
 */
function initialAccentHue(): number {
  if (typeof document !== "undefined") {
    const v = document.documentElement.style.getPropertyValue("--accent-hue").trim();
    const n = Number(v);
    if (v && !Number.isNaN(n)) return n;
  }
  return DEFAULTS.accentHue;
}

/** Seed the custom accent from the data-accent-custom attribute injected by Rust
 *  before first paint (so a custom accent doesn't flash on startup). */
function initialAccentCustom(): AccentCustom | null {
  if (typeof document !== "undefined") {
    const v = document.documentElement.dataset.accentCustom;
    if (v) {
      const parts = v.trim().split(/\s+/).map(Number);
      if (parts.length === 3 && parts.every((n) => !Number.isNaN(n))) {
        return { l: parts[0], c: parts[1], h: parts[2] };
      }
    }
  }
  return null;
}

/** Seed the interface font from the data-interface-font attribute injected by
 *  Rust before first paint, so a custom UI font doesn't flash on startup. */
function initialInterfaceFont(): string {
  if (typeof document !== "undefined") {
    const v = document.documentElement.dataset.interfaceFont;
    if (v) return v;
  }
  return DEFAULTS.interfaceFont;
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

let accentPersistTimer: ReturnType<typeof setTimeout> | undefined;

export const useSettingsStore = create<SettingsState>((set) => ({
  ...DEFAULTS,
  themeMode: initialThemeMode(),
  accentHue: initialAccentHue(),
  accentCustom: initialAccentCustom(),
  interfaceFont: initialInterfaceFont(),
  loaded: false,

  setThemeMode: (mode) => {
    set({ themeMode: mode });
    persist("app_theme", mode);
  },

  setAccentHue: (hue) => {
    // Choosing a preset hue clears any custom colour.
    set({ accentHue: hue, accentCustom: null });
    persist("app_accent_hue", String(hue));
    persist("app_accent_custom", "");
  },

  setAccentCustom: (custom) => {
    set({ accentCustom: custom });
    // Debounce so dragging the wheel / sliders doesn't spam the backend.
    if (accentPersistTimer) clearTimeout(accentPersistTimer);
    const value = custom ? `${custom.l} ${custom.c} ${custom.h}` : "";
    accentPersistTimer = setTimeout(() => persist("app_accent_custom", value), 200);
  },

  setInterfaceFont: (font) => {
    set({ interfaceFont: font });
    persist("app_interface_font", font);
  },

  setTerminalFontSize: (size) => {
    const clamped = Math.max(8, Math.min(42, size));
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
          case "app_accent_hue": updates.accentHue = Number(value) || DEFAULTS.accentHue; break;
          case "app_accent_custom": {
            const parts = value.trim().split(/\s+/).map(Number);
            updates.accentCustom = parts.length === 3 && parts.every((n) => !Number.isNaN(n))
              ? { l: parts[0], c: parts[1], h: parts[2] }
              : null;
            break;
          }
          case "terminal_font_size": updates.terminalFontSize = Number(value) || DEFAULTS.terminalFontSize; break;
          case "terminal_font_family": updates.terminalFontFamily = value || DEFAULTS.terminalFontFamily; break;
          case "terminal_cursor_style": updates.terminalCursorStyle = (value as CursorStyle) || DEFAULTS.terminalCursorStyle; break;
          case "terminal_cursor_blink": updates.terminalCursorBlink = value !== "false"; break;
          case "terminal_line_height": updates.terminalLineHeight = Number(value) || DEFAULTS.terminalLineHeight; break;
          case "terminal_scrollback": updates.terminalScrollback = Number(value) || DEFAULTS.terminalScrollback; break;
          case "transfer_concurrency": updates.transferConcurrency = Number(value) || DEFAULTS.transferConcurrency; break;
          case "app_interface_font": updates.interfaceFont = value || DEFAULTS.interfaceFont; break;
        }
      }

      set({ ...updates, loaded: true });
    } catch {
      set({ loaded: true }); // Use defaults if backend unavailable
    }
  },
}));
