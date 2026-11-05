// Issue #148: let the user choose whether a new split pane starts in the
// source pane's directory or the home directory.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { splitTerminalPane } from "./split-pane";
import { useSessionStore } from "../stores/session-store";
import { useSettingsStore } from "../stores/settings-store";

describe("splitTerminalPane", () => {
  const splitPane = vi.fn();

  beforeEach(() => {
    invoke.mockReset();
    splitPane.mockReset();
    useSessionStore.setState({ splitPane });
  });

  it("defaults to the home directory (the old behaviour)", async () => {
    expect(useSettingsStore.getState().terminalSplitInCwd).toBe(false);
    invoke.mockResolvedValue("new-1");

    await splitTerminalPane("horizontal", "src-1");

    expect(invoke).toHaveBeenCalledWith("ssh_split_session", { sourceSessionId: "src-1", inCwd: false });
    expect(splitPane).toHaveBeenCalledWith("horizontal", "src-1", "new-1");
  });

  it("asks for the source pane's directory when the setting is on", async () => {
    invoke.mockResolvedValue(undefined); // save_setting
    useSettingsStore.getState().setTerminalSplitInCwd(true);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("save_setting", { key: "terminal_split_in_cwd", value: "true" }),
    );
    invoke.mockReset();
    invoke.mockResolvedValue("new-2");

    await splitTerminalPane("vertical", "src-1");

    expect(invoke).toHaveBeenCalledWith("ssh_split_session", { sourceSessionId: "src-1", inCwd: true });
    expect(splitPane).toHaveBeenCalledWith("vertical", "src-1", "new-2");
  });

  it("leaves the layout alone when the split fails", async () => {
    invoke.mockRejectedValue(new Error("channel refused"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await splitTerminalPane("horizontal", "src-1");

    expect(splitPane).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
