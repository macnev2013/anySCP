import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { createSftpProvider, toExplorerEntry } from "../../providers/sftp-provider";
import type { ExplorerEntry } from "../../types/explorer";

function file(name: string, extra: Partial<ExplorerEntry> = {}): ExplorerEntry {
  return { id: `/${name}`, name, entryType: "File", size: 10, modified: null,
    permissionsDisplay: null, permissions: null, isSymlink: false, storageClass: null, ...extra };
}
function table(entries = [file("image.png"), file("document.pdf")], supported = true) {
  const preview = vi.fn(); const close = vi.fn(); const selection = vi.fn();
  const props = { provider: createSftpProvider("session"), entries, sortBy: "name" as const, sortAsc: true,
    onSortChange: vi.fn(), clipboard: null, onSetClipboard: vi.fn(), onNavigate: vi.fn(), onDownload: vi.fn(),
    onDelete: vi.fn(async () => {}), onRename: vi.fn(async () => {}),
    onQuickLook: supported ? preview : undefined, onQuickLookClose: close, onQuickLookSelectionChange: selection,
    quickLookActive: true };
  const view = render(<ExplorerFileTable {...props} />);
  const row = (name = entries[0].name) => view.getByTestId(`explorer-entry-${name}`);
  return { ...view, props, preview, close, selection, row };
}

describe("Explorer Quick Look entry points", () => {
  it("previews a selected binary and routes Esc while a request is active", () => {
    const view = table(); const row = view.row();
    fireEvent.click(row); row.focus();
    expect(fireEvent.keyDown(row, { key: " " })).toBe(false);
    expect(view.preview).toHaveBeenCalledWith(view.props.entries[0], expect.any(Function));
    expect(fireEvent.keyDown(row, { key: "Escape" })).toBe(false);
    expect(view.close).toHaveBeenCalledOnce();
    view.preview.mock.calls[0][1]();
    expect(document.activeElement).toBe(row);
  });

  it.each([{ isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }])("ignores composition/modifiers: %j", (extra) => {
    const view = table(); fireEvent.click(view.row());
    expect(fireEvent.keyDown(view.row(), { key: " ", ...extra })).toBe(true);
    expect(view.preview).not.toHaveBeenCalled();
  });

  it("suppresses scrolling while holding Space without retriggering preview", () => {
    const view = table(); fireEvent.click(view.row());
    expect(fireEvent.keyDown(view.row(), { key: " ", repeat: true })).toBe(false);
    expect(view.preview).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(view.row(), { key: "Escape", repeat: true })).toBe(false);
    expect(view.close).not.toHaveBeenCalled();
  });

  it("does not intercept Space on unsupported platforms", () => {
    const view = table(undefined, false); fireEvent.click(view.row());
    expect(fireEvent.keyDown(view.row(), { key: " " })).toBe(true);
    fireEvent.contextMenu(view.row());
    expect(view.queryByRole("menuitem", { name: "Quick Look" })).toBeNull();
  });

  it("requires exactly one regular file, with no symlink or special-file normalization", () => {
    const entries = [file("file.txt"), file("folder", { entryType: "Directory" }), file("link.txt", { isSymlink: true }), file("pipe", { entryType: "Other" })];
    const view = table(entries);
    fireEvent.keyDown(view.row(), { key: " " });
    for (const entry of entries.slice(1)) {
      fireEvent.click(view.row(entry.name));
      fireEvent.keyDown(view.row(entry.name), { key: " " });
    }
    fireEvent.click(view.row("file.txt"));
    fireEvent.click(view.row("folder"), { metaKey: true });
    fireEvent.keyDown(view.row("file.txt"), { key: " " });
    fireEvent.contextMenu(view.row("file.txt"));
    expect(view.queryByRole("menuitem", { name: "Quick Look" })).toBeNull();
    expect(view.preview).not.toHaveBeenCalled();
    expect(toExplorerEntry({ name: "pipe", path: "/pipe", entry_type: "Other", size: 0, permissions: 0, permissions_display: "---------", modified: null, is_symlink: false }).entryType).toBe("Other");
  });

  it("selects an unselected context-menu row and previews that file", () => {
    const view = table();
    fireEvent.click(view.row());
    fireEvent.contextMenu(view.row("document.pdf"));
    fireEvent.click(view.getByRole("menuitem", { name: "Quick Look" }));
    expect(view.preview).toHaveBeenCalledWith(view.props.entries[1], expect.any(Function));
    expect(view.selection.mock.lastCall?.[0]).toEqual([view.props.entries[1]]);
  });

  it("leaves inline rename/new-file input alone", () => {
    const view = table();
    fireEvent.contextMenu(view.row());
    fireEvent.click(view.getByRole("menuitem", { name: "Rename" }));
    const input = view.getByRole("textbox", { name: "Rename file" });
    expect(fireEvent.keyDown(input, { key: " " })).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(view.preview).not.toHaveBeenCalled();
    expect(view.close).not.toHaveBeenCalled();
  });
});
