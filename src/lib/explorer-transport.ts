// Explorer transport dispatch.
//
// SFTP and SCP expose an identical command surface — same operation names,
// same argument shapes, same return types — differing only in the command
// prefix (`sftp_` vs `scp_`) and the session-id argument key (`sftpSessionId`
// vs `scpSessionId`). This module centralises that difference so the Explorer
// UI can stay transport-agnostic.
//
// SCP is used transparently as a fallback when a host has the SFTP subsystem
// disabled; the user never picks it explicitly (see exploreHost).

export type Transport = "sftp" | "scp";

/** The Tauri event channel that carries transfer progress for a transport. */
export function transferEventName(transport: Transport): string {
  return `${transport}:transfer`;
}

/** The session-id argument key a transport's commands expect. */
function sessionKey(transport: Transport): "sftpSessionId" | "scpSessionId" {
  return transport === "scp" ? "scpSessionId" : "sftpSessionId";
}

/**
 * Invoke a transport command. `op` is the bare operation (e.g. "list_dir");
 * the prefix and session-id key are derived from `transport`. `extra` holds
 * the operation-specific arguments (path, oldPath, sourcePaths, …).
 */
export async function explorerInvoke<T>(
  transport: Transport,
  op: string,
  sessionId: string,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(`${transport}_${op}`, {
    [sessionKey(transport)]: sessionId,
    ...extra,
  });
}
