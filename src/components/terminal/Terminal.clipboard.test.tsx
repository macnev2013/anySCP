import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";

// Shared spies/handles, hoisted so the vi.mock factories below can use them.
const mocks = vi.hoisted(() => ({
  selectionHandlers: [] as Array<() => void>,
  paste: vi.fn(),
  getSelection: vi.fn(() => "SELECTED"),
  readText: vi.fn(async () => "CLIP"),
  writeText: vi.fn(async () => undefined),
  fit: vi.fn(),
  refresh: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  readText: mocks.readText,
  writeText: mocks.writeText,
}));

// xterm needs a real DOM/measurements; replace the registry with a fake term so
// we can drive onSelectionChange / paste directly.
vi.mock("../../stores/terminal-instances", () => {
  const term = {
    options: {} as Record<string, unknown>,
    rows: 24,
    refresh: mocks.refresh,
    getSelection: mocks.getSelection,
    paste: mocks.paste,
    onSelectionChange: (cb: () => void) => {
      mocks.selectionHandlers.push(cb);
      return { dispose: mocks.dispose };
    },
  };
  const entry = { term, element: document.createElement("div"), fitAddon: { fit: mocks.fit }, resizeTimer: null };
  return {
    ensureTerminal: () => entry,
    getTerminal: () => entry,
    getTerminalTheme: () => ({}),
    disposeTerminal: vi.fn(),
  };
});

// The SSH output subscription is irrelevant to clipboard behaviour.
vi.mock("../../hooks/use-ssh-events", () => ({ useSshOutput: () => {} }));

import { Terminal } from "./Terminal";
import { useSettingsStore } from "../../stores/settings-store";

const SID = "s1";
const container = () => document.querySelector(`[data-testid="terminal-${SID}"]`) as HTMLElement;

beforeAll(() => {
  // jsdom lacks both; Terminal's mount effect uses them.
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready: Promise.resolve() } });
});

describe("Terminal — clipboard behaviours (#71)", () => {
  beforeEach(() => {
    mocks.selectionHandlers.length = 0;
    mocks.paste.mockClear();
    mocks.readText.mockClear();
    mocks.writeText.mockClear();
    useSettingsStore.setState({ terminalCopyOnSelect: false, terminalPasteButton: "none" });
  });

  it("copies the selection when copy-on-select is enabled", async () => {
    useSettingsStore.setState({ terminalCopyOnSelect: true });
    render(<Terminal sessionId={SID} />);
    act(() => mocks.selectionHandlers.forEach((cb) => cb()));
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith("SELECTED"));
  });

  it("does not copy on selection when copy-on-select is disabled", async () => {
    render(<Terminal sessionId={SID} />);
    act(() => mocks.selectionHandlers.forEach((cb) => cb()));
    await Promise.resolve();
    expect(mocks.writeText).not.toHaveBeenCalled();
  });

  it("pastes on middle-click when the paste button is 'middle'", async () => {
    useSettingsStore.setState({ terminalPasteButton: "middle" });
    render(<Terminal sessionId={SID} />);
    fireEvent.mouseDown(container(), { button: 1 });
    await waitFor(() => expect(mocks.paste).toHaveBeenCalledWith("CLIP"));
  });

  it("pastes on right-click when the paste button is 'right'", async () => {
    useSettingsStore.setState({ terminalPasteButton: "right" });
    render(<Terminal sessionId={SID} />);
    fireEvent.contextMenu(container());
    await waitFor(() => expect(mocks.paste).toHaveBeenCalledWith("CLIP"));
  });

  it("does not paste when the wrong button is used or paste is off", async () => {
    useSettingsStore.setState({ terminalPasteButton: "middle" });
    render(<Terminal sessionId={SID} />);
    // Right-click while configured for middle → no paste.
    fireEvent.contextMenu(container());
    // Primary button down → no paste.
    fireEvent.mouseDown(container(), { button: 0 });
    await Promise.resolve();
    expect(mocks.paste).not.toHaveBeenCalled();
  });
});
