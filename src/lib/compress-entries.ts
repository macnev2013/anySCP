import { explorerInvoke, type Transport } from "./explorer-transport";
import { toast } from "../stores/toast-store";
import type { ExplorerEntry } from "../types/explorer";

/** Mirrors the Rust `ArchiveInfo`. */
export interface ArchiveInfo {
  path: string;
  name: string;
  format: "zip" | "tar.gz";
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return typeof err === "string" ? err : "unknown error";
}

/**
 * Pack `entries` (all inside `dir`) into one archive on the server, next to
 * them, so a folder of many small files downloads as a single file (#133).
 * Uses zip when the server has it, otherwise tar.gz. Reports progress and the
 * outcome as toasts, and calls `refresh` so the new archive shows up.
 * Resolves to the created archive, or `null` on failure.
 */
export async function compressEntries(
  transport: Transport,
  sessionId: string,
  dir: string,
  entries: ExplorerEntry[],
  refresh: () => Promise<void>,
): Promise<ArchiveInfo | null> {
  if (entries.length === 0) return null;
  const what = entries.length === 1 ? `"${entries[0].name}"` : `${entries.length} items`;
  const progress = toast.progress(`Compressing ${what}…`);
  let info: ArchiveInfo;
  try {
    info = await explorerInvoke<ArchiveInfo>(transport, "compress", sessionId, {
      dir,
      names: entries.map((e) => e.name),
    });
  } catch (err) {
    toast.error(`Couldn't compress ${what}: ${errorMessage(err)}`);
    return null;
  } finally {
    toast.dismiss(progress);
  }

  toast.success(
    info.format === "zip"
      ? `Created "${info.name}"`
      : `Created "${info.name}" (zip isn't installed on the server, so it's a tar.gz)`,
  );
  try {
    await refresh();
  } catch (err) {
    // The archive exists; a failed reload must not read as a failed compress.
    console.error("Directory refresh after compress failed:", err);
  }
  return info;
}
