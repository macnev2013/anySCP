// Issue #133: compress files/folders into one archive on the server so they
// download as a single file.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { compressEntries } from "./compress-entries";
import { useToastStore } from "../stores/toast-store";
import type { ExplorerEntry } from "../types/explorer";

function entry(name: string, entryType: "File" | "Directory" = "Directory"): ExplorerEntry {
  return {
    name,
    id: `/srv/${name}`,
    entryType,
    size: 0,
    modified: null,
    permissionsDisplay: null,
    permissions: null,
    isSymlink: false,
    storageClass: null,
  };
}

const toasts = () => useToastStore.getState().toasts.map((t) => [t.kind, t.message]);

describe("compressEntries", () => {
  beforeEach(() => {
    invoke.mockReset();
    useToastStore.setState({ toasts: [] });
  });

  it("compresses over the session's transport, refreshes, and reports the archive", async () => {
    invoke.mockResolvedValue({ path: "/srv/logs.zip", name: "logs.zip", format: "zip" });
    const refresh = vi.fn(async () => {});

    const info = await compressEntries("sftp", "s-1", "/srv", [entry("logs")], refresh);

    expect(invoke).toHaveBeenCalledWith("sftp_compress", {
      sftpSessionId: "s-1",
      dir: "/srv",
      names: ["logs"],
    });
    expect(info?.name).toBe("logs.zip");
    expect(refresh).toHaveBeenCalledTimes(1);
    // The progress toast is gone; only the outcome remains.
    expect(toasts()).toEqual([["success", 'Created "logs.zip"']]);
  });

  it("uses the SCP command for SCP sessions and says when it fell back to tar.gz", async () => {
    invoke.mockResolvedValue({ path: "/srv/Archive.tar.gz", name: "Archive.tar.gz", format: "tar.gz" });

    await compressEntries("scp", "c-1", "/srv", [entry("a"), entry("b.txt", "File")], async () => {});

    expect(invoke).toHaveBeenCalledWith("scp_compress", {
      scpSessionId: "c-1",
      dir: "/srv",
      names: ["a", "b.txt"],
    });
    expect(toasts()).toEqual([
      ["success", `Created "Archive.tar.gz" (zip isn't installed on the server, so it's a tar.gz)`],
    ]);
  });

  it("shows the server's error and doesn't refresh when compressing fails", async () => {
    invoke.mockRejectedValue({ message: "Compression failed: Permission denied" });
    const refresh = vi.fn(async () => {});

    const info = await compressEntries("sftp", "s-1", "/srv", [entry("a"), entry("b")], refresh);

    expect(info).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(toasts()).toEqual([
      ["error", "Couldn't compress 2 items: Compression failed: Permission denied"],
    ]);
  });

  it("still reports success when only the refresh fails", async () => {
    invoke.mockResolvedValue({ path: "/srv/logs.zip", name: "logs.zip", format: "zip" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const info = await compressEntries("sftp", "s-1", "/srv", [entry("logs")], async () => {
      throw new Error("connection dropped");
    });

    expect(info?.name).toBe("logs.zip");
    expect(toasts()).toEqual([["success", 'Created "logs.zip"']]);
    err.mockRestore();
  });
});
