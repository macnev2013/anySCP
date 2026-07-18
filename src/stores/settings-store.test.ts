import { describe, it, expect, beforeEach, vi } from "vitest";
import { useSettingsStore } from "./settings-store";

// The store reaches the backend via a dynamic `import("@tauri-apps/api/core")`,
// so we mock that module's `invoke` (persist is fire-and-forget, hence waitFor).
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

describe("settings-store — terminal clipboard settings (#71)", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    // Reset just the keys under test to their defaults.
    useSettingsStore.setState({ terminalCopyOnSelect: false, terminalPasteButton: "none" });
  });

  it("defaults to copy-on-select off and paste disabled", () => {
    const s = useSettingsStore.getState();
    expect(s.terminalCopyOnSelect).toBe(false);
    expect(s.terminalPasteButton).toBe("none");
  });

  it("toggles copy-on-select and persists it as a string", async () => {
    useSettingsStore.getState().setTerminalCopyOnSelect(true);
    expect(useSettingsStore.getState().terminalCopyOnSelect).toBe(true);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_setting", {
        key: "terminal_copy_on_select",
        value: "true",
      }),
    );
  });

  it("sets the paste button and persists the raw choice", async () => {
    useSettingsStore.getState().setTerminalPasteButton("middle");
    expect(useSettingsStore.getState().terminalPasteButton).toBe("middle");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_setting", {
        key: "terminal_paste_button",
        value: "middle",
      }),
    );
  });

  it("loads both settings from persisted key/value pairs", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_all_settings") {
        return [
          ["terminal_copy_on_select", "true"],
          ["terminal_paste_button", "right"],
          // editors already seeded — skips the detect_editors first-run path.
          ["editors_seeded", "true"],
        ];
      }
      return undefined;
    });

    await useSettingsStore.getState().loadSettings();

    const s = useSettingsStore.getState();
    expect(s.terminalCopyOnSelect).toBe(true);
    expect(s.terminalPasteButton).toBe("right");
  });

  it("falls back to the default for an unrecognized paste-button value", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_all_settings") {
        return [
          ["terminal_paste_button", "bogus"],
          ["editors_seeded", "true"],
        ];
      }
      return undefined;
    });

    await useSettingsStore.getState().loadSettings();

    expect(useSettingsStore.getState().terminalPasteButton).toBe("none");
  });
});

describe("settings-store — explorer double-click action", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    useSettingsStore.setState({ explorerDoubleClickAction: "download" });
  });

  it("defaults to download", () => {
    expect(useSettingsStore.getState().explorerDoubleClickAction).toBe("download");
  });

  it("sets and persists the double-click action", async () => {
    useSettingsStore.getState().setExplorerDoubleClickAction("open");
    expect(useSettingsStore.getState().explorerDoubleClickAction).toBe("open");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_setting", {
        key: "explorer_double_click_action",
        value: "open",
      }),
    );
  });

  it("loads the action, falling back to download for an unknown value", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_all_settings") {
        return [
          ["explorer_double_click_action", "nonsense"],
          ["editors_seeded", "true"],
        ];
      }
      return undefined;
    });

    await useSettingsStore.getState().loadSettings();

    expect(useSettingsStore.getState().explorerDoubleClickAction).toBe("download");
  });
});

describe("settings-store — interface monospace font", () => {
  const DEFAULT_MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";

  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    useSettingsStore.setState({ interfaceMonoFont: DEFAULT_MONO });
  });

  it("persists a chosen mono font under its settings key", async () => {
    useSettingsStore.getState().setInterfaceMonoFont("'Fira Code', monospace");
    expect(useSettingsStore.getState().interfaceMonoFont).toBe("'Fira Code', monospace");
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_setting", {
        key: "app_interface_mono_font",
        value: "'Fira Code', monospace",
      }),
    );
  });

  it("loads a persisted mono font and defaults when the value is empty", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_all_settings") {
        return [
          ["app_interface_mono_font", "'Hack', monospace"],
          ["editors_seeded", "true"],
        ];
      }
      return undefined;
    });
    await useSettingsStore.getState().loadSettings();
    expect(useSettingsStore.getState().interfaceMonoFont).toBe("'Hack', monospace");

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "load_all_settings") {
        return [
          ["app_interface_mono_font", ""],
          ["editors_seeded", "true"],
        ];
      }
      return undefined;
    });
    await useSettingsStore.getState().loadSettings();
    expect(useSettingsStore.getState().interfaceMonoFont).toBe(DEFAULT_MONO);
  });
});
