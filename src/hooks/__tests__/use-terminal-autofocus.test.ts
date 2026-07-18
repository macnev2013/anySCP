import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTerminalAutoFocus } from "../use-terminal-autofocus";
import { useTabStore, pageTabId } from "../../stores/tab-store";
import { useSessionStore } from "../../stores/session-store";
import { useTerminalSearchStore } from "../../stores/terminal-search-store";
import { getTerminal } from "../../stores/terminal-instances";
import type { UnifiedTab } from "../../stores/tab-store";

vi.mock("../../stores/terminal-instances", () => ({
  getTerminal: vi.fn(),
}));

const focus = vi.fn();

function setTabs(tabs: UnifiedTab[], activeTabId: string | null) {
  useTabStore.setState({
    tabs: new Map(tabs.map((t) => [t.id, t])),
    tabOrder: tabs.map((t) => t.id),
    activeTabId,
  });
}

const termTab: UnifiedTab = { type: "terminal", id: "tab-1", label: "server" };
const sftpTab: UnifiedTab = { type: "sftp", id: "tab-2", label: "files" };

describe("useTerminalAutoFocus", () => {
  beforeEach(() => {
    vi.mocked(getTerminal).mockReturnValue({
      term: { focus },
    } as unknown as ReturnType<typeof getTerminal>);
    focus.mockClear();
    // Run rAF callbacks synchronously so focus lands inside act()
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    setTabs([termTab, sftpTab], termTab.id);
    useSessionStore.setState({ activeSessionId: "sess-1" });
    useTerminalSearchStore.setState({
      openSessions: new Set(),
      focusedSessionId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setTabs([], pageTabId("hosts"));
    useSessionStore.setState({ activeSessionId: null });
  });

  it("focuses the active terminal when a terminal tab is active", () => {
    renderHook(() => useTerminalAutoFocus());
    expect(getTerminal).toHaveBeenCalledWith("sess-1");
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("does not focus when the active tab is not a terminal", () => {
    setTabs([termTab, sftpTab], sftpTab.id);
    renderHook(() => useTerminalAutoFocus());
    expect(focus).not.toHaveBeenCalled();
  });

  it("does not focus when there is no active session", () => {
    useSessionStore.setState({ activeSessionId: null });
    renderHook(() => useTerminalAutoFocus());
    expect(focus).not.toHaveBeenCalled();
  });

  it("yields to the search bar when it was the last-focused element", () => {
    useTerminalSearchStore.setState({
      openSessions: new Set(["sess-1"]),
      focusedSessionId: "sess-1",
    });
    renderHook(() => useTerminalAutoFocus());
    expect(focus).not.toHaveBeenCalled();
  });

  it("focuses the terminal when search is open but the terminal was last focused", () => {
    useTerminalSearchStore.setState({
      openSessions: new Set(["sess-1"]),
      focusedSessionId: null,
    });
    renderHook(() => useTerminalAutoFocus());
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("refocuses when switching back to the terminal tab", () => {
    renderHook(() => useTerminalAutoFocus());
    focus.mockClear();

    act(() => setTabs([termTab, sftpTab], sftpTab.id));
    expect(focus).not.toHaveBeenCalled();

    act(() => setTabs([termTab, sftpTab], termTab.id));
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("refocuses when the active pane changes within a split", () => {
    renderHook(() => useTerminalAutoFocus());
    focus.mockClear();

    act(() => useSessionStore.setState({ activeSessionId: "sess-2" }));
    expect(getTerminal).toHaveBeenLastCalledWith("sess-2");
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("tolerates a session whose terminal is not instantiated yet", () => {
    vi.mocked(getTerminal).mockReturnValue(undefined);
    expect(() => renderHook(() => useTerminalAutoFocus())).not.toThrow();
    expect(focus).not.toHaveBeenCalled();
  });
});
