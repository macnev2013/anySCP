import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../stores/session-store";
import { useSftpStore } from "../stores/sftp-store";
import { useTabStore } from "../stores/tab-store";
import { toast } from "../stores/toast-store";

function errorMessage(err: unknown, fallback: string): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return typeof err === "string" ? err : fallback;
}

/**
 * Open a file explorer tab on a terminal pane's SSH connection, starting in
 * the directory the pane's shell is in (issue #149).
 *
 * The explorer shares the terminal's connection, so no re-authentication is
 * needed. When the shell's directory can't be read (non-Linux server), the
 * explorer opens in the home directory as usual.
 */
export async function openExplorerFromTerminal(sessionId: string): Promise<void> {
  const session = useSessionStore.getState().sessions.get(sessionId);
  if (!session) return;

  // Best effort: a failed lookup must not stop the explorer from opening.
  let cwd: string | null = null;
  try {
    cwd = await invoke<string | null>("ssh_shell_cwd", { sessionId });
  } catch {
    cwd = null;
  }

  let explorerSessionId: string;
  let transport: "sftp" | "scp" = "sftp";
  try {
    try {
      explorerSessionId = await invoke<string>("sftp_open", { sessionId });
    } catch (sftpErr) {
      // SFTP subsystem disabled — fall back to SCP on the same connection.
      try {
        explorerSessionId = await invoke<string>("scp_open", { sessionId });
        transport = "scp";
      } catch {
        throw sftpErr;
      }
    }
  } catch (err) {
    toast.error(`Couldn't open the file explorer: ${errorMessage(err, "unknown error")}`);
    return;
  }

  useSftpStore.getState().openSession(
    explorerSessionId,
    sessionId,
    session.label,
    session.hostConfig.username,
    false,
    cwd ?? undefined,
  );
  useTabStore.getState().addTab({
    type: "sftp",
    id: explorerSessionId,
    label: session.label,
    transport,
  });
}
