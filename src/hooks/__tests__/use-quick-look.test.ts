import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useQuickLook } from "../use-quick-look";
import type { QuickLookState, PreviewIdentity } from "../../lib/quick-look";
import type { ExplorerEntry } from "../../types/explorer";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), error: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ listen: mocks.listen }) }));
vi.mock("../../stores/toast-store", () => ({ toast: { error: mocks.error } }));
const file: ExplorerEntry = { name: "image.png", id: "/image.png", entryType: "File", size: 100,
  modified: null, permissions: null, permissionsDisplay: null, isSymlink: false, storageClass: null };
const target = { transport: "s3" as const, sessionId: "session", bucketName: "A", key: file.id };
let receive: (event: { payload: QuickLookState }) => void;
function identity(): PreviewIdentity {
  return [...mocks.invoke.mock.calls].reverse().find((call) => call[0] === "quicklook_open")![1].identity;
}
function event(phase: QuickLookState["phase"]) {
  receive({ payload: { ...identity(), phase, bytesReceived: 40, totalBytes: 100 } });
}

describe("Quick Look owner lifecycle and feedback", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "quicklook_capabilities") return { supported: true };
      if (command === "quicklook_state") return { revision: 0, current: null };
      return true;
    });
    mocks.listen.mockImplementation(async (_event, handler) => { receive = handler; return mocks.unlisten; });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("delays progress 300ms, keeps the original timer across byte events, removes it on visible", async () => {
    const hook = renderHook(() => useQuickLook(true, "A"));
    await act(async () => {});
    expect(hook.result.current.supported).toBe(true);
    act(() => hook.result.current.toggle(file, target, vi.fn()));
    act(() => vi.advanceTimersByTime(200));
    act(() => event("downloading"));
    act(() => vi.advanceTimersByTime(99));
    expect(hook.result.current.progress).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(hook.result.current.progress?.bytesReceived).toBe(40);
    act(() => event("visible"));
    expect(hook.result.current.progress).toBeNull();
    hook.unmount();
  });

  it.each(["bucket", "directory", "transport", "session"])("invalidates immediately on %s scope changes and ignores late completion", async (scope) => {
    const hook = renderHook(({ location }) => useQuickLook(true, location), { initialProps: { location: "A" } });
    await act(async () => {});
    const restore = vi.fn();
    act(() => hook.result.current.toggle(file, target, restore));
    hook.rerender({ location: scope });
    expect(mocks.invoke).toHaveBeenLastCalledWith("quicklook_close", expect.any(Object));
    act(() => { event("visible"); event("closed"); vi.runOnlyPendingTimers(); });
    expect(hook.result.current.hasPreview).toBe(false);
    expect(restore).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
  });

  it("cancels inactive tabs and skips focus restoration after leaving", async () => {
    const hook = renderHook(({ active }) => useQuickLook(active, "A"), { initialProps: { active: true } });
    await act(async () => {});
    const restore = vi.fn(); act(() => hook.result.current.toggle(file, target, restore));
    hook.rerender({ active: false });
    act(() => { event("closed"); vi.runOnlyPendingTimers(); });
    expect(hook.result.current.supported).toBe(false);
    expect(restore).not.toHaveBeenCalled();
    hook.unmount(); expect(mocks.unlisten).toHaveBeenCalledOnce();
  });

  it("restores focus after native close while the original Explorer is active", async () => {
    const hook = renderHook(() => useQuickLook(true, "A")); await act(async () => {});
    const restore = vi.fn(); act(() => hook.result.current.toggle(file, target, restore));
    act(() => { event("visible"); event("closed"); vi.runOnlyPendingTimers(); });
    expect(restore).toHaveBeenCalledOnce();
  });

  it("does not steal focus from a different application/window", async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    const hook = renderHook(() => useQuickLook(true, "A")); await act(async () => {});
    const restore = vi.fn(); act(() => hook.result.current.toggle(file, target, restore));
    act(() => { event("closed"); vi.runOnlyPendingTimers(); });
    expect(restore).not.toHaveBeenCalled();
  });
});
