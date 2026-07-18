import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { TerminalSearchBar } from "../TerminalSearchBar";
import { useTabStore } from "../../../stores/tab-store";
import { useSessionStore } from "../../../stores/session-store";
import { useTerminalSearchStore } from "../../../stores/terminal-search-store";

// The search addon lives on the real xterm instance; none exists in jsdom.
// The component already guards every addon call, so "no addon" is a valid state.
vi.mock("../../../stores/terminal-registry", () => ({
  getSearchAddon: () => undefined,
}));

describe("TerminalSearchBar focus", () => {
  beforeEach(() => {
    // Run rAF callbacks synchronously so focus lands inside act()
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    useTabStore.setState({ activeTabId: "tab-1" });
    useSessionStore.setState({ activeSessionId: "sess-1" });
    useTerminalSearchStore.setState({
      openSessions: new Set(["sess-1"]),
      focusedSessionId: null,
      queries: new Map(),
      results: new Map(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useSessionStore.setState({ activeSessionId: null });
  });

  it("focuses its input on mount when its session is active", () => {
    render(<TerminalSearchBar sessionId="sess-1" />);
    expect(screen.getByTestId("terminal-search-input")).toHaveFocus();
  });

  it("does not grab focus when another session is active", () => {
    render(<TerminalSearchBar sessionId="sess-2" />);
    expect(screen.getByTestId("terminal-search-input")).not.toHaveFocus();
  });

  it("re-focuses its input when the containing tab becomes active again", () => {
    render(<TerminalSearchBar sessionId="sess-1" />);
    const input = screen.getByTestId("terminal-search-input");

    // Switching away hides the pane and drops focus to <body>
    act(() => {
      useTabStore.setState({ activeTabId: "tab-2" });
    });
    (input as HTMLInputElement).blur();
    expect(input).not.toHaveFocus();

    act(() => {
      useTabStore.setState({ activeTabId: "tab-1" });
    });
    expect(input).toHaveFocus();
  });

  it("does not steal focus on tab switches when its session is inactive", () => {
    // A second pane's bar in a split: its session is not the active one
    useSessionStore.setState({ activeSessionId: "sess-1" });
    render(<TerminalSearchBar sessionId="sess-2" />);
    const input = screen.getByTestId("terminal-search-input");

    act(() => {
      useTabStore.setState({ activeTabId: "tab-2" });
    });
    act(() => {
      useTabStore.setState({ activeTabId: "tab-1" });
    });
    expect(input).not.toHaveFocus();
  });
});
