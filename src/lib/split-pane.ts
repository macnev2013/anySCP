import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../stores/session-store";
import { useSettingsStore } from "../stores/settings-store";

/**
 * Split a terminal pane: open a new shell on the same SSH connection and lay
 * it out next to (`horizontal`) or below (`vertical`) the source pane.
 *
 * With the "open in current directory" setting on (#148), the new shell
 * starts in the source pane's directory; otherwise in the home directory.
 */
export async function splitTerminalPane(
  direction: "horizontal" | "vertical",
  sourceSessionId: string,
): Promise<void> {
  try {
    const newId = await invoke<string>("ssh_split_session", {
      sourceSessionId,
      inCwd: useSettingsStore.getState().terminalSplitInCwd,
    });
    useSessionStore.getState().splitPane(direction, sourceSessionId, newId);
  } catch (err) {
    console.error("Split failed:", err);
  }
}
