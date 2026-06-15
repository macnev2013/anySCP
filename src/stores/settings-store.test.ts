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
