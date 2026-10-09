import { describe, it, expect, vi, beforeEach } from "vitest";

// explorerInvoke (SFTP/SCP) and the S3/local providers all funnel through the
// Tauri `invoke`. Mock it and assert each provider maps the abstract operation
// to the exact command + args its backend expects — the divergence the unified
// provider layer exists to hide.
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async (..._args: unknown[]) => undefined as unknown) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { createSftpProvider } from "./sftp-provider";
import { createS3Provider } from "./s3-provider";
import { createLocalProvider } from "./local-provider";
import type { ExplorerEntry } from "../types/explorer";

const dir = (id: string): ExplorerEntry => ({
  name: id.split("/").pop() ?? id,
  id,
  entryType: "Directory",
  size: 0,
  modified: null,
  permissionsDisplay: null,
  permissions: null,
  isSymlink: false,
  storageClass: null,
});
const file = (id: string): ExplorerEntry => ({ ...dir(id), entryType: "File" });

/** The args object of the last matching invoke call. */
function argsOf(cmd: string): Record<string, unknown> | undefined {
  const calls = invoke.mock.calls.filter((c) => c[0] === cmd);
  return calls[calls.length - 1]?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
});

describe("createSftpProvider", () => {
  it("lists via sftp_list_dir and maps rows to ExplorerEntry", async () => {
    invoke.mockResolvedValueOnce([
      {
        name: "a.txt",
        path: "/home/a.txt",
        entry_type: "File",
        size: 5,
        permissions: 0o644,
        permissions_display: "rw-r--r--",
        modified: 100,
        is_symlink: false,
      },
    ]);
    const p = createSftpProvider("sess", "sftp");
    const rows = await p.listDir("/home");
    expect(argsOf("sftp_list_dir")).toEqual({ sftpSessionId: "sess", path: "/home" });
    expect(rows[0]).toMatchObject({ id: "/home/a.txt", entryType: "File", permissionsDisplay: "rw-r--r--" });
  });

  it("delete passes isDir; rename passes oldPath/newPath", async () => {
    const p = createSftpProvider("sess");
    await p.delete(dir("/d"));
    expect(argsOf("sftp_delete")).toEqual({ sftpSessionId: "sess", path: "/d", isDir: true });
    await p.rename!(file("/f.txt"), "/g.txt");
    expect(argsOf("sftp_rename")).toEqual({ sftpSessionId: "sess", oldPath: "/f.txt", newPath: "/g.txt" });
  });

  it("chmod recursive on a dir uses chmod_recursive; non-recursive uses chmod", async () => {
    const p = createSftpProvider("sess");
    await p.chmod!(dir("/d"), 0o755, true);
    expect(argsOf("sftp_chmod_recursive")).toEqual({ sftpSessionId: "sess", path: "/d", mode: 0o755 });
    await p.chmod!(file("/f"), 0o600, false);
    expect(argsOf("sftp_chmod")).toEqual({ sftpSessionId: "sess", path: "/f", mode: 0o600 });
  });

  it("enqueueUpload maps to remoteDir; enqueueDownload to remotePaths/localDir", async () => {
    const p = createSftpProvider("sess");
    await p.enqueueUpload!(["/tmp/a"], "/remote");
    expect(argsOf("sftp_enqueue_upload")).toEqual({ sftpSessionId: "sess", localPaths: ["/tmp/a"], remoteDir: "/remote" });
    await p.enqueueDownload!(["/r/a"], "/local");
    expect(argsOf("sftp_enqueue_download")).toEqual({ sftpSessionId: "sess", remotePaths: ["/r/a"], localDir: "/local" });
  });

  it("scp transport switches command prefix and session key", async () => {
    invoke.mockResolvedValueOnce([]);
    const p = createSftpProvider("sess", "scp");
    expect(p.type).toBe("scp");
    await p.listDir("/");
    expect(argsOf("scp_list_dir")).toEqual({ scpSessionId: "sess", path: "/" });
  });
});

describe("createS3Provider", () => {
  it("delete routes dir→delete_prefix, file→delete_object", async () => {
    const p = createS3Provider("s3", "bucket");
    await p.delete(dir("photos/"));
    expect(argsOf("s3_delete_prefix")).toEqual({ s3SessionId: "s3", prefix: "photos/" });
    await p.delete(file("a.txt"));
    expect(argsOf("s3_delete_object")).toEqual({ s3SessionId: "s3", key: "a.txt" });
  });

  it("mkdir forces a trailing slash (S3 folder marker)", async () => {
    const p = createS3Provider("s3", "bucket");
    await p.mkdir("photos/2024");
    expect(argsOf("s3_create_folder")).toEqual({ s3SessionId: "s3", prefix: "photos/2024/" });
  });

  it("enqueueUpload maps targetDir to prefix; presignUrl passes an expiry", async () => {
    const p = createS3Provider("s3", "bucket");
    await p.enqueueUpload!(["/tmp/a"], "photos/");
    expect(argsOf("s3_enqueue_upload")).toEqual({ s3SessionId: "s3", localPaths: ["/tmp/a"], prefix: "photos/" });
    invoke.mockResolvedValueOnce("https://signed");
    await p.presignUrl!(file("a.txt"));
    expect(argsOf("s3_presign_url")).toMatchObject({ s3SessionId: "s3", key: "a.txt" });
  });

  it("has no rename/move (capabilities off)", () => {
    const p = createS3Provider("s3", "bucket");
    expect(p.capabilities.canRename).toBe(false);
    expect(p.rename).toBeUndefined();
    expect(p.move).toBeUndefined();
  });
});

describe("createLocalProvider", () => {
  it("lists via local_list_dir; delete/rename map to local_* args", async () => {
    invoke.mockResolvedValueOnce([]);
    const p = createLocalProvider("local:tab1");
    expect(p.type).toBe("local");
    await p.listDir("/home/ivan");
    expect(argsOf("local_list_dir")).toEqual({ path: "/home/ivan" });

    await p.delete(dir("/home/ivan/d"));
    expect(argsOf("local_delete")).toEqual({ path: "/home/ivan/d", isDir: true });

    await p.rename!(file("/home/ivan/a"), "/home/ivan/b");
    expect(argsOf("local_rename")).toEqual({ oldPath: "/home/ivan/a", newPath: "/home/ivan/b" });
  });

  it("path helpers use the platform separator (Unix in tests)", () => {
    const p = createLocalProvider("local:tab1");
    expect(p.joinPath("/home/ivan", "docs")).toBe("/home/ivan/docs");
    expect(p.parentPath("/home/ivan")).toBe("/home");
    expect(p.parentPath("/a")).toBe("/");
  });

  it("has transfers off (cross-pane handles them)", () => {
    const p = createLocalProvider("local:tab1");
    expect(p.capabilities.canUpload).toBe(false);
    expect(p.capabilities.canDownload).toBe(false);
    expect(p.enqueueUpload).toBeUndefined();
  });
});
