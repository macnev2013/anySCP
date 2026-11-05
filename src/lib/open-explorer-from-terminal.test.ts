// Issue #149: open the file explorer from a terminal pane, landing in the
// directory the shell is in.

import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { openExplorerFromTerminal } from "./open-explorer-from-terminal";
import { useSessionStore } from "../stores/session-store";
import { useSftpStore } from "../stores/sftp-store";
import { useTabStore } from "../stores/tab-store";
import { useToastStore } from "../stores/toast-store";

const SID = "ssh-1";

/** Route invoke() calls by command name. */
function backend(handlers: Record<string, (args: unknown) => unknown>) {
  invoke.mockImplementation(async (cmd: string, args: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unexpected command ${cmd}`);
    return h(args);
  });
}

describe("openExplorerFromTerminal", () => {
  beforeEach(() => {
    invoke.mockReset();
    useToastStore.setState({ toasts: [] });
    useSftpStore.setState({ sessions: new Map() });
    useSessionStore.getState().addSession(SID, {
      host: "box",
      port: 22,
      username: "deploy",
      auth_method: { type: "password", password: "x" },
      label: "prod",
    });
  });

  it("opens an SFTP tab on the same connection, starting in the shell's directory", async () => {
    backend({
      ssh_shell_cwd: () => "/app/logs/05f54a66",
      sftp_open: (a) => {
        expect(a).toEqual({ sessionId: SID });
        return "sftp-9";
      },
    });

    await openExplorerFromTerminal(SID);

    const s = useSftpStore.getState().sessions.get("sftp-9");
    expect(s?.sshSessionId).toBe(SID);
    expect(s?.startDirectory).toBe("/app/logs/05f54a66");
    expect(s?.username).toBe("deploy");
    expect(useTabStore.getState().activeTabId).toBe("sftp-9");
    expect(useTabStore.getState().tabs.get("sftp-9")).toMatchObject({ type: "sftp", transport: "sftp" });
  });

  it("still opens (in the home directory) when the directory can't be read", async () => {
    backend({
      ssh_shell_cwd: () => { throw { message: "no /proc" }; },
      sftp_open: () => "sftp-10",
    });

    await openExplorerFromTerminal(SID);

    expect(useSftpStore.getState().sessions.get("sftp-10")?.startDirectory).toBe("");
  });

  it("falls back to SCP when the SFTP subsystem is disabled", async () => {
    backend({
      ssh_shell_cwd: () => null,
      sftp_open: () => { throw { message: "subsystem request failed" }; },
      scp_open: () => "scp-1",
    });

    await openExplorerFromTerminal(SID);

    expect(useTabStore.getState().tabs.get("scp-1")).toMatchObject({ type: "sftp", transport: "scp" });
  });

  it("shows an error toast when no explorer can be opened", async () => {
    backend({
      ssh_shell_cwd: () => "/srv",
      sftp_open: () => { throw { message: "channel refused" }; },
      scp_open: () => { throw { message: "scp missing" }; },
    });

    await openExplorerFromTerminal(SID);

    expect(useToastStore.getState().toasts).toEqual([
      expect.objectContaining({ kind: "error", message: "Couldn't open the file explorer: channel refused" }),
    ]);
    expect(useSftpStore.getState().sessions.size).toBe(0);
  });
});
