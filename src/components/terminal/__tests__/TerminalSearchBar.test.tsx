import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { TerminalSearchBar } from "../TerminalSearchBar";
import { useTabStore } from "../../../stores/tab-store";
import { useSessionStore } from "../../../stores/session-store";
import { useTerminalSearchStore } from "../../../stores/terminal-search-store";

// The search addon lives on the real xterm instance; none exists in jsdom.
// The component already guards every addon call, so "no addon" is a valid state.
vi.mock("../../../stores/terminal-registry", () => ({
  getSearchAddon: () => undefined,
}));

// Stand-in for the session's xterm: the search bar identifies "focus moved to
// the terminal" by the instance's textarea, and refocuses it on close.
let termTextarea: HTMLTextAreaElement;
const termFocus = vi.fn();
vi.mock("../../../stores/terminal-instances", () => ({
  getTerminal: (id: string) =>
    id === "sess-1" ? { term: { textarea: termTextarea, focus: termFocus } } : undefined,
}));

describe("TerminalSearchBar focus", () => {
  beforeEach(() => {
    // Run rAF callbacks synchronously so focus lands inside act()
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    termTextarea = document.createElement("textarea");
    document.body.appendChild(termTextarea);
    termFocus.mockClear();
    useTabStore.setState({ activeTabId: "tab-1" });
    useSessionStore.setState({ activeSessionId: "sess-1" });
    // Mirror openSearch(): opening marks the bar as the last-focused element
    useTerminalSearchStore.setState({
      openSessions: new Set(["sess-1"]),
      focusedSessionId: "sess-1",
      queries: new Map(),
      results: new Map(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    termTextarea.remove();
    useSessionStore.setState({ activeSessionId: null });
  });

  const switchTab = (tabId: string) =>
    act(() => {
      useTabStore.setState({ activeTabId: tabId });
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
    switchTab("tab-2");
    (input as HTMLInputElement).blur();
    expect(input).not.toHaveFocus();

    switchTab("tab-1");
    expect(input).toHaveFocus();
  });

  it("stays out of the way when the terminal was focused last", () => {
    render(<TerminalSearchBar sessionId="sess-1" />);
    const input = screen.getByTestId("terminal-search-input");
    expect(input).toHaveFocus();

    // User clicks back into the terminal: focus moves to its textarea
    act(() => termTextarea.focus());
    expect(useTerminalSearchStore.getState().focusedSessionId).toBeNull();

    // Tab away and back: the bar must not steal focus from the terminal
    switchTab("tab-2");
    act(() => termTextarea.blur());
    switchTab("tab-1");
    expect(input).not.toHaveFocus();
  });

  it("re-marks itself as focus owner when the user returns to the input", () => {
    render(<TerminalSearchBar sessionId="sess-1" />);
    const input = screen.getByTestId("terminal-search-input");

    act(() => termTextarea.focus());
    expect(useTerminalSearchStore.getState().focusedSessionId).toBeNull();

    act(() => (input as HTMLInputElement).focus());
    expect(useTerminalSearchStore.getState().focusedSessionId).toBe("sess-1");
  });

  it("does not steal focus on tab switches when its session is inactive", () => {
    // A second pane's bar in a split: its session is not the active one
    render(<TerminalSearchBar sessionId="sess-2" />);
    const input = screen.getByTestId("terminal-search-input");

    switchTab("tab-2");
    switchTab("tab-1");
    expect(input).not.toHaveFocus();
  });

  it("hands focus back to the terminal when closed with Escape", () => {
    render(<TerminalSearchBar sessionId="sess-1" />);
    const input = screen.getByTestId("terminal-search-input");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(useTerminalSearchStore.getState().openSessions.has("sess-1")).toBe(false);
    expect(termFocus).toHaveBeenCalledTimes(1);
  });
});
