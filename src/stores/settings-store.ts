import { create } from "zustand";

export type CursorStyle = "block" | "bar" | "underline";
export type ThemeMode = "dark" | "light";
/** Which mouse button pastes the clipboard into the terminal (#71). */
export type PasteButton = "none" | "right" | "middle";

/** Full custom accent colour in oklch components (lightness, chroma, hue). */
export interface AccentCustom { l: number; c: number; h: number }

/**
 * A configured external editor. `args` is a command template where `{path}` is
 * replaced with the file to open (the file is appended if `{path}` is absent).
 * `id` is a UI-only stable key; the backend ignores it. `execPath` is the
 * absolute path to the binary, or a macOS .app bundle.
 */
export interface EditorConfig {
  id: string;
  name: string;
  execPath: string;
  args: string;
}

interface SettingsState {
  // Appearance
  themeMode: ThemeMode;
  accentHue: number;
  accentCustom: AccentCustom | null;
  interfaceFont: string;

  // Updates
  autoUpdate: boolean;
  skippedUpdateVersion: string | null;

  // Terminal appearance
  terminalFontSize: number;
  terminalFontFamily: string;
  terminalCursorStyle: CursorStyle;
  terminalCursorBlink: boolean;
  terminalLineHeight: number;
  terminalScrollback: number;

  // Terminal clipboard
  terminalCopyOnSelect: boolean;
  terminalPasteButton: PasteButton;

  // Transfers
  transferConcurrency: number;

  // External editors
  editors: EditorConfig[];
  defaultEditorId: string | null;

  // State
  loaded: boolean;

  // Actions
  setThemeMode: (mode: ThemeMode) => void;
  setAccentHue: (hue: number) => void;
  setAccentCustom: (custom: AccentCustom | null) => void;
  setInterfaceFont: (font: string) => void;
  setAutoUpdate: (enabled: boolean) => void;
  setSkippedUpdateVersion: (version: string) => void;
  setTerminalFontSize: (size: number) => void;
  setTerminalFontFamily: (family: string) => void;
  setTerminalCursorStyle: (style: CursorStyle) => void;
  setTerminalCursorBlink: (blink: boolean) => void;
  setTerminalLineHeight: (height: number) => void;
  setTerminalScrollback: (lines: number) => void;
  setTerminalCopyOnSelect: (enabled: boolean) => void;
  setTerminalPasteButton: (button: PasteButton) => void;
  setTransferConcurrency: (n: number) => void;
  addEditor: (editor: Omit<EditorConfig, "id">) => void;
  updateEditor: (id: string, patch: Partial<Omit<EditorConfig, "id">>) => void;
  removeEditor: (id: string) => void;
  setDefaultEditor: (id: string | null) => void;
  loadSettings: () => Promise<void>;
}

// Defaults
const DEFAULTS = {
  themeMode: "dark" as ThemeMode,
  accentHue: 250,
  accentCustom: null as AccentCustom | null,
  interfaceFont: "'Geist', system-ui, sans-serif",
  autoUpdate: true,
  skippedUpdateVersion: null as string | null,
  terminalFontSize: 14,
  terminalFontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, monospace",
  terminalCursorStyle: "bar" as CursorStyle,
  terminalCursorBlink: true,
  terminalLineHeight: 1.2,
  terminalScrollback: 5000,
  terminalCopyOnSelect: false,
  terminalPasteButton: "none" as PasteButton,
  transferConcurrency: 3,
  editors: [] as EditorConfig[],
  defaultEditorId: null as string | null,
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

/** Persist the whole editor config as one JSON blob (it's a list, not a scalar). */
function persistEditors(editors: EditorConfig[], defaultEditorId: string | null) {
  persist("editors_config", JSON.stringify({ editors, defaultEditorId }));
}

/** Editors that make the best out-of-the-box default, most-preferred first.
 *  Names must match the backend registry display names (see editors/mod.rs). */
const PREFERRED_DEFAULT_EDITORS = ["VS Code", "VSCodium", "Cursor", "Windsurf", "Sublime Text", "Zed"];

/** Old → new display names for editors renamed in the backend registry, applied
 *  to already-saved configs on load so existing users see the canonical name. */
const RENAMED_EDITORS: Record<string, string> = { "Visual Studio Code": "VS Code" };

/** Choose which seeded editor should be the default — a popular IDE if present,
 *  otherwise just the first one detected. */
function pickDefaultEditorId(editors: EditorConfig[]): string | null {
  for (const name of PREFERRED_DEFAULT_EDITORS) {
    const match = editors.find((e) => e.name === name);
    if (match) return match.id;
  }
  return editors[0]?.id ?? null;
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

  setAutoUpdate: (enabled) => {
    set({ autoUpdate: enabled });
    persist("app_auto_update", String(enabled));
  },

  setSkippedUpdateVersion: (version) => {
    set({ skippedUpdateVersion: version });
    persist("app_skipped_update", version);
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

  setTerminalCopyOnSelect: (enabled) => {
    set({ terminalCopyOnSelect: enabled });
    persist("terminal_copy_on_select", String(enabled));
  },

  setTerminalPasteButton: (button) => {
    set({ terminalPasteButton: button });
    persist("terminal_paste_button", button);
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

  addEditor: (editor) => set((s) => {
    const next = [...s.editors, { ...editor, id: crypto.randomUUID() }];
    // The first editor added becomes the default automatically.
    const defaultEditorId = s.defaultEditorId ?? next[next.length - 1].id;
    persistEditors(next, defaultEditorId);
    return { editors: next, defaultEditorId };
  }),

  updateEditor: (id, patch) => set((s) => {
    const next = s.editors.map((e) => (e.id === id ? { ...e, ...patch } : e));
    persistEditors(next, s.defaultEditorId);
    return { editors: next };
  }),

  removeEditor: (id) => set((s) => {
    const next = s.editors.filter((e) => e.id !== id);
    // If the default was removed, fall back to the first remaining editor.
    const defaultEditorId = s.defaultEditorId === id ? (next[0]?.id ?? null) : s.defaultEditorId;
    persistEditors(next, defaultEditorId);
    return { editors: next, defaultEditorId };
  }),

  setDefaultEditor: (id) => set((s) => {
    persistEditors(s.editors, id);
    return { defaultEditorId: id };
  }),

  loadSettings: async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const pairs = await invoke<[string, string][]>("load_all_settings");

      const updates: Partial<SettingsState> = {};
      let editorsSeeded = false;
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
          case "terminal_copy_on_select": updates.terminalCopyOnSelect = value === "true"; break;
          case "terminal_paste_button": updates.terminalPasteButton = value === "right" || value === "middle" ? value : DEFAULTS.terminalPasteButton; break;
          case "transfer_concurrency": updates.transferConcurrency = Number(value) || DEFAULTS.transferConcurrency; break;
          case "app_interface_font": updates.interfaceFont = value || DEFAULTS.interfaceFont; break;
          case "app_auto_update": updates.autoUpdate = value !== "false"; break;
          case "app_skipped_update": updates.skippedUpdateVersion = value || null; break;
          case "editors_config": {
            try {
              const parsed = JSON.parse(value) as { editors?: EditorConfig[]; defaultEditorId?: string | null };
              const defaultEditorId = parsed.defaultEditorId ?? null;
              if (Array.isArray(parsed.editors)) {
                let renamed = false;
                const migrated = parsed.editors.map((e) => {
                  const next = RENAMED_EDITORS[e.name];
                  if (next && next !== e.name) { renamed = true; return { ...e, name: next }; }
                  return e;
                });
                updates.editors = migrated;
                if (renamed) persistEditors(migrated, defaultEditorId); // keep the rename
              }
              updates.defaultEditorId = defaultEditorId;
            } catch { /* ignore malformed config */ }
            break;
          }
          case "editors_seeded": editorsSeeded = value === "true"; break;
        }
      }

      // First run: auto-detect installed editors and add them so "Edit" / "Open
      // With" work out of the box. Tracked by a dedicated `editors_seeded` flag
      // (NOT the mere presence of editors_config) so that a user who later
      // deletes every editor won't have them silently re-added.
      if (!editorsSeeded) {
        const current = updates.editors ?? [];
        if (current.length > 0) {
          // A real config already exists (e.g. manually added) — respect it.
          persist("editors_seeded", "true");
        } else {
          try {
            const detected = await invoke<{ name: string; execPath: string; args: string }[]>("detect_editors");
            if (detected.length > 0) {
              const editors: EditorConfig[] = detected.map((d) => ({
                id: crypto.randomUUID(),
                name: d.name,
                execPath: d.execPath,
                args: d.args || "{path}",
              }));
              const defaultEditorId = pickDefaultEditorId(editors);
              updates.editors = editors;
              updates.defaultEditorId = defaultEditorId;
              persistEditors(editors, defaultEditorId);
              persist("editors_seeded", "true");
            }
            // Nothing detected → leave unseeded so we retry on the next launch.
          } catch { /* detection unavailable — leave unseeded to retry next launch */ }
        }
      }

      set({ ...updates, loaded: true });
    } catch {
      set({ loaded: true }); // Use defaults if backend unavailable
    }
  },
}));
