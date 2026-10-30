import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { createSftpProvider } from "../../providers/sftp-provider";
import type { ExplorerEntry } from "../../types/explorer";

function entry(name: string): ExplorerEntry {
  return { name, id: `/home/${name}`, entryType: "File", size: 1, modified: null, permissionsDisplay: null, permissions: null, isSymlink: false, storageClass: null };
}
const hidden = entry(".env"), a = entry("a.txt"), b = entry("b.txt");

function setup() {
  const onSetClipboard = vi.fn(), onDelete = vi.fn(async () => {}), onDragOut = vi.fn();
  const props = { provider: createSftpProvider("s"), sortBy: "name" as const, sortAsc: true, onSortChange: vi.fn(), clipboard: null, onSetClipboard, onDelete, onDragOut, onNavigate: vi.fn(), onDownload: vi.fn(), onRename: vi.fn(), currentPath: "/home" };
  const contents = (entries: ExplorerEntry[], hiddenCount = 0) => <><button>Visibility toggle</button><ExplorerFileTable {...props} entries={entries} hiddenCount={hiddenCount} /></>;
  const view = render(contents([hidden, a, b]));
  return { ...props, hide: () => view.rerender(contents([a, b], 1)), show: () => view.rerender(contents([hidden, a, b])) };
}
const row = (name: string) => screen.getByTestId(`explorer-entry-${name}`);

it("immediately constrains copy, cut, delete and all-select to visible entries, without restoring old selections", () => {
  const table = setup();
  fireEvent.click(row(".env"));
  fireEvent.click(row("a.txt"), { ctrlKey: true });
  table.hide();
  fireEvent.keyDown(row("a.txt"), { key: "c", ctrlKey: true });
  expect(table.onSetClipboard).toHaveBeenLastCalledWith(expect.objectContaining({ entries: [a] }));
  fireEvent.keyDown(row("a.txt"), { key: "x", ctrlKey: true });
  expect(table.onSetClipboard).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "cut", entries: [a] }));
  fireEvent.keyDown(row("a.txt"), { key: "a", ctrlKey: true });
  fireEvent.keyDown(row("a.txt"), { key: "Delete" });
  fireEvent.click(screen.getByTestId("explorer-delete-confirm-button"));
  expect(table.onDelete).toHaveBeenCalledWith([a, b]);
  table.show();
  fireEvent.keyDown(row("a.txt"), { key: "c", ctrlKey: true });
  expect(table.onSetClipboard.mock.calls.every(([clipboard]) => clipboard.entries.every((entry: ExplorerEntry) => entry.id !== hidden.id))).toBe(true);
});

it("clears a hidden Shift anchor and returns focus to a passive file-list target", () => {
  const table = setup();
  act(() => row(".env").focus());
  fireEvent.click(row(".env"));
  table.hide();
  expect(screen.getByLabelText("File list")).toHaveFocus();
  fireEvent.click(row("b.txt"), { shiftKey: true });
  fireEvent.keyDown(row("b.txt"), { key: "c", ctrlKey: true });
  expect(table.onSetClipboard).toHaveBeenCalledWith(expect.objectContaining({ entries: [b] }));
});

describe("unsubmitted entry interactions", () => {
  it.each(["menu", "rename", "properties", "delete"])("closes %s when its entry is hidden", (interaction) => {
    const table = setup();
    fireEvent.contextMenu(row(".env"));
    if (interaction === "rename") fireEvent.click(screen.getByText("Rename"));
    if (interaction === "properties") fireEvent.click(screen.getByText("Properties"));
    if (interaction === "delete") fireEvent.click(screen.getByText("Delete"));
    table.hide();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.queryByTestId("explorer-delete-confirm")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue(".env")).not.toBeInTheDocument();
    table.show();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(table.onDelete).not.toHaveBeenCalled();
  });

  it("cancels pending pointer drags and removes their listeners", () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    const hitTest = vi.fn(() => null);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });
    const removeListener = vi.spyOn(window, "removeEventListener");
    const table = setup();
    fireEvent.pointerDown(row(".env"), { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 40 });
    expect(screen.getByText(/Move 1 item/)).toBeInTheDocument();
    table.hide();
    expect(removeListener).toHaveBeenCalledWith("pointermove", expect.any(Function));
    fireEvent.pointerMove(window, { clientX: -10, clientY: 20 });
    fireEvent.pointerUp(window, { clientX: -10, clientY: 20 });
    expect(table.onDragOut).not.toHaveBeenCalled();
    expect(screen.queryByText(/Move 1 item/)).not.toBeInTheDocument();
    removeListener.mockRestore();
    vi.unstubAllGlobals();
  });
});

it("distinguishes an empty listing from an all-hidden listing and offers recovery", () => {
  const onShowHiddenFiles = vi.fn();
  const props = { provider: createSftpProvider("s"), entries: [], sortBy: "name" as const, sortAsc: true, onSortChange: vi.fn(), clipboard: null, onSetClipboard: vi.fn(), onNavigate: vi.fn(), onDownload: vi.fn(), onDelete: vi.fn(), onShowHiddenFiles };
  const view = render(<ExplorerFileTable {...props} />);
  expect(screen.getByText("This folder is empty")).toBeInTheDocument();
  view.rerender(<ExplorerFileTable {...props} hiddenCount={3} loading />);
  expect(screen.getByText("Hidden items are not shown")).toBeInTheDocument();
  expect(screen.getByText("3 loaded items are hidden")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Show hidden files" }));
  expect(onShowHiddenFiles).toHaveBeenCalledOnce();
});


it("keeps the scroller out of the focus order and does not steal focus after a user already blurred the row", () => {
  const table = setup();
  const scroller = screen.getByLabelText("File list");
  expect(scroller).not.toHaveAttribute("tabindex");
  act(() => row(".env").focus());
  act(() => row(".env").blur());
  expect(document.body).toHaveFocus();
  table.hide();
  expect(document.body).toHaveFocus();
});


it("restores a removed row to a passive target; Enter/Space do nothing and arrows resume row navigation", () => {
  const table = setup();
  act(() => row(".env").focus());
  table.hide();
  const scroller = screen.getByLabelText("File list");
  expect(scroller).toHaveFocus();
  fireEvent.keyDown(scroller, { key: "Enter" });
  fireEvent.keyDown(scroller, { key: " " });
  expect(table.onNavigate).not.toHaveBeenCalled();
  expect(table.onDownload).not.toHaveBeenCalled();
  fireEvent.keyDown(scroller, { key: "ArrowDown" });
  expect(row("a.txt")).toHaveFocus();
  expect(scroller).not.toHaveAttribute("tabindex");
});
