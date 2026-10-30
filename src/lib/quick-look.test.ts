import { describe, it, expect, vi } from "vitest";
import { QuickLookClient, PreviewClock, type QuickLookState, type QuickLookTarget, type PreviewIdentity } from "./quick-look";
import type { ExplorerEntry } from "../types/explorer";
import type { invoke as Invoke } from "@tauri-apps/api/core";

const file: ExplorerEntry = { name: "test.png", id: "/test.png", entryType: "File", size: 1,
  modified: null, permissions: null, permissionsDisplay: null, isSymlink: false, storageClass: null };
const target: QuickLookTarget = { transport: "scp", sessionId: "session", path: file.id };
function fixture(revisions = new PreviewClock()) {
  let receiver: (state: QuickLookState) => void = () => {};
  const invoke = vi.fn(async (command: string, _args?: Record<string, unknown>) => {
    if (command === "quicklook_capabilities") return { supported: true };
    if (command === "quicklook_state") return { revision: 10, current: null };
    return true;
  });
  const unlisten = vi.fn();
  const listen = vi.fn(async (fn: typeof receiver): Promise<() => void> => { receiver = fn; return unlisten; });
  const changed = vi.fn(); const error = vi.fn(); const restore = vi.fn();
  const client = new QuickLookClient("owner", changed, error, { invoke: invoke as typeof Invoke, listen }, revisions);
  const event = (identity: PreviewIdentity, phase: QuickLookState["phase"], extra: Partial<QuickLookState> = {}) => receiver({ ...identity, phase, bytesReceived: 0, totalBytes: null, ...extra });
  const identity = () => [...invoke.mock.calls].reverse().find((call) => call[0] === "quicklook_open")?.[1] as unknown;
  return { client, invoke, listen, unlisten, changed, error, restore, event,
    getIdentity: () => (identity() as { identity: PreviewIdentity }).identity };
}

// Tests inspect IPC arguments, including revisions; they do not simulate a
// native panel. The separate native probe exercises that integration.
describe("Quick Look request ordering", () => {
  it("installs a listener and reconciles the revision before accepting actions", async () => {
    const f = fixture();
    f.client.toggle(file, target, f.restore);
    expect(f.invoke).not.toHaveBeenCalled();
    await f.client.connect();
    f.client.toggle(file, target, f.restore);
    expect(f.getIdentity().revision).toBe(11);
    expect(f.listen).toHaveBeenCalledOnce();
    expect(f.invoke).toHaveBeenLastCalledWith("quicklook_open", expect.objectContaining({ target }));
    f.client.dispose();
  });

  it("toggles with a newer close revision, restoring only after backend teardown", async () => {
    const f = fixture(); await f.client.connect();
    f.client.toggle(file, target, f.restore); const id = f.getIdentity();
    f.client.toggle(file, target, f.restore);
    expect(f.invoke).toHaveBeenLastCalledWith("quicklook_close", { identity: { ...id, revision: id.revision + 1 } });
    expect(f.restore).not.toHaveBeenCalled();
    f.event(id, "cancelled");
    expect(f.restore).toHaveBeenCalledOnce(); expect(f.error).not.toHaveBeenCalled();
    f.client.dispose();
  });

  it("ignores A completing after B, duplicate closes and regressive progress", async () => {
    const f = fixture(); await f.client.connect();
    f.client.toggle(file, target, f.restore); const a = f.getIdentity();
    const bFile = { ...file, id: "/B.png" };
    f.client.toggle(bFile, { ...target, path: bFile.id }, f.restore); const b = f.getIdentity();
    f.changed.mockClear();
    f.event(a, "visible"); f.event(a, "closed");
    expect(f.changed).not.toHaveBeenCalled(); expect(f.restore).not.toHaveBeenCalled();
    f.event(b, "visible"); f.event(b, "downloading");
    expect(f.changed).toHaveBeenCalledOnce();
    f.event(b, "closed"); f.event(b, "closed");
    expect(f.restore).toHaveBeenCalledOnce();
    f.client.dispose();
  });

  it("selection/navigation invalidation cancels without focus stealing or error", async () => {
    const f = fixture(); await f.client.connect();
    f.client.toggle(file, target, f.restore); const id = f.getIdentity();
    f.client.selectionChanged([file]);
    expect(f.invoke.mock.calls.filter((c) => c[0] === "quicklook_close")).toHaveLength(0);
    f.client.selectionChanged([]); f.event(id, "cancelled");
    expect(f.restore).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled();
    f.client.dispose();
  });

  it("shares revisions across owners so delayed cleanup cannot roll them back", async () => {
    const revisions = new PreviewClock(); const a = fixture(revisions); const b = fixture(revisions);
    await Promise.all([a.client.connect(), b.client.connect()]);
    a.client.toggle(file, target, a.restore); const old = a.getIdentity();
    b.client.toggle(file, target, b.restore); const current = b.getIdentity();
    a.client.dispose();
    const close = a.invoke.mock.lastCall?.[1] as unknown as { identity: PreviewIdentity };
    expect(current.revision).toBeGreaterThan(old.revision);
    expect(close.identity.revision).toBeGreaterThan(current.revision);
    b.client.dispose();
  });

  it("unsubscribes a listener that finishes mounting after dispose", async () => {
    const f = fixture(); let complete!: (value: () => void) => void;
    f.listen.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const connecting = f.client.connect(); await Promise.resolve();
    f.client.dispose(); complete(f.unlisten); await connecting;
    expect(f.unlisten).toHaveBeenCalledOnce();
  });

  it("shows a structured backend error exactly once", async () => {
    const f = fixture(); await f.client.connect();
    f.client.toggle(file, target, f.restore); const id = f.getIdentity();
    f.event(id, "error", { error: { kind: "too_large", message: "100 MiB maximum" } });
    f.event(id, "error", { error: { kind: "too_large", message: "duplicate" } });
    expect(f.error).toHaveBeenCalledExactlyOnceWith("100 MiB maximum");
    f.client.dispose();
  });
});
