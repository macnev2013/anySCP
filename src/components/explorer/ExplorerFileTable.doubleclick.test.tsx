import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { createSftpProvider } from "../../providers/sftp-provider";
import { useSettingsStore, type EditorConfig } from "../../stores/settings-store";
import type { ExplorerEntry } from "../../types/explorer";

const EDITOR: EditorConfig = { id: "e1", name: "VS Code", execPath: "/usr/bin/code", args: "{path}" };

function entry(over: Partial<ExplorerEntry> = {}): ExplorerEntry {
  return {
    name: "notes.txt",
    id: "/home/notes.txt",
    entryType: "File",
    size: 12,
    modified: null,
    permissionsDisplay: "rw-r--r--",
    permissions: 0o644,
    isSymlink: false,
    storageClass: null,
    ...over,
  };
}

const DIR = entry({ name: "logs", id: "/home/logs", entryType: "Directory" });
const TEXT = entry({ name: "config.yaml", id: "/home/config.yaml" });
const BINARY = entry({ name: "clip.mov", id: "/home/clip.mov" });

/** Render the table with the given entries and spy callbacks; returns the spies. */
function renderTable(entries: ExplorerEntry[]) {
  const onNavigate = vi.fn();
  const onDownload = vi.fn();
  const onEditInEditor = vi.fn();
  const utils = render(
    <ExplorerFileTable
      provider={createSftpProvider("s")}
      entries={entries}
      sortBy="name"
      sortAsc
      onSortChange={() => {}}
      clipboard={null}
      onSetClipboard={() => {}}
      onNavigate={onNavigate}
      onDownload={onDownload}
      onDelete={async () => {}}
      onEditInEditor={onEditInEditor}
      currentPath="/home"
      loading={false}
    />,
  );
  const dblClick = (name: string) => {
    const row = utils.container.querySelector(`[data-entry-name="${name}"]`);
    if (!row) throw new Error(`row '${name}' not rendered`);
    fireEvent.doubleClick(row);
  };
  return { onNavigate, onDownload, onEditInEditor, dblClick };
}

describe("ExplorerFileTable — double-click action", () => {
  beforeEach(() => {
    // Default seed: one editor configured, action = download.
    useSettingsStore.setState({
      editors: [EDITOR],
      defaultEditorId: EDITOR.id,
      explorerDoubleClickAction: "download",
    });
  });

  it("navigates into a directory regardless of the action", () => {
    useSettingsStore.setState({ explorerDoubleClickAction: "open" });
    const { onNavigate, onDownload, onEditInEditor, dblClick } = renderTable([DIR]);
    dblClick("logs");
    expect(onNavigate).toHaveBeenCalledWith("/home/logs");
    expect(onDownload).not.toHaveBeenCalled();
    expect(onEditInEditor).not.toHaveBeenCalled();
  });

  it("downloads a file when the action is 'download'", () => {
    const { onDownload, onEditInEditor, dblClick } = renderTable([TEXT]);
    dblClick("config.yaml");
    expect(onDownload).toHaveBeenCalledWith(TEXT);
    expect(onEditInEditor).not.toHaveBeenCalled();
  });

  it("opens a text file in the default editor when the action is 'open'", () => {
    useSettingsStore.setState({ explorerDoubleClickAction: "open" });
    const { onDownload, onEditInEditor, dblClick } = renderTable([TEXT]);
    dblClick("config.yaml");
    expect(onEditInEditor).toHaveBeenCalledWith(TEXT, expect.objectContaining({ id: "e1" }));
    expect(onDownload).not.toHaveBeenCalled();
  });

  it("downloads a binary file even when the action is 'open'", () => {
    useSettingsStore.setState({ explorerDoubleClickAction: "open" });
    const { onDownload, onEditInEditor, dblClick } = renderTable([BINARY]);
    dblClick("clip.mov");
    expect(onDownload).toHaveBeenCalledWith(BINARY);
    expect(onEditInEditor).not.toHaveBeenCalled();
  });

  it("falls back to download when 'open' is set but no editor is configured", () => {
    useSettingsStore.setState({ explorerDoubleClickAction: "open", editors: [], defaultEditorId: null });
    const { onDownload, onEditInEditor, dblClick } = renderTable([TEXT]);
    dblClick("config.yaml");
    expect(onDownload).toHaveBeenCalledWith(TEXT);
    expect(onEditInEditor).not.toHaveBeenCalled();
  });
});
