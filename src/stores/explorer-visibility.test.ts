import { beforeEach, describe, expect, it } from "vitest";
import { useSftpStore } from "./sftp-store";
import { useS3Store } from "./s3-store";

beforeEach(() => {
  useSftpStore.setState({ sessions: new Map(), clipboard: null });
  useS3Store.setState({ sessions: new Map() });
});

describe("session visibility overrides", () => {
  it("preserves SFTP/SCP choices through navigation, refresh, tab changes and sudo swap; resets on reopen", () => {
    const store = useSftpStore.getState();
    store.openSession("a", "ssh", "A");
    store.openSession("b", "ssh", "B");
    expect(useSftpStore.getState().sessions.get("a")?.showHiddenFilesOverride).toBeNull();
    store.setShowHiddenFilesOverride("a", false);
    store.setEntries("a", "/.config", []);
    store.setLoading("a", true);
    store.setActiveSftpSession("b");
    store.swapSession("a", "sudo-a", true);
    expect(useSftpStore.getState().sessions.get("sudo-a")).toMatchObject({ currentPath: "/.config", showHiddenFilesOverride: false });
    expect(useSftpStore.getState().sessions.get("b")?.showHiddenFilesOverride).toBeNull();
    store.closeSession("sudo-a");
    store.openSession("sudo-a", "ssh", "A");
    expect(useSftpStore.getState().sessions.get("sudo-a")?.showHiddenFilesOverride).toBeNull();
  });

  it("preserves S3 choices across bucket/prefix/page changes; resets on reopen", () => {
    const store = useS3Store.getState();
    store.openSession("s", "S3");
    store.setShowHiddenFilesOverride("s", false);
    store.setCurrentBucket("s", "bucket");
    store.setEntries("s", ".parent/", [], "next");
    store.appendEntries("s", ".parent/", [], null);
    store.setCurrentBucket("s", "other");
    expect(useS3Store.getState().sessions.get("s")?.showHiddenFilesOverride).toBe(false);
    store.closeSession("s");
    store.openSession("s", "S3");
    expect(useS3Store.getState().sessions.get("s")?.showHiddenFilesOverride).toBeNull();
  });
});
