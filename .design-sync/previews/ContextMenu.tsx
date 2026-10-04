import { ContextMenu } from "anyscp";
import { Activity, Copy, FolderOpen, Pencil, TerminalSquare, Trash2, Download, Scissors, ClipboardPaste, FilePlus, FolderPlus } from "lucide-react";

const noop = () => {};

export const HostActions = () => (
  <ContextMenu
    position={{ x: 24, y: 24 }}
    onClose={noop}
    items={[
      { label: "Ping", icon: Activity, onClick: noop },
      { label: "Terminal", icon: TerminalSquare, onClick: noop },
      { label: "Explorer", icon: FolderOpen, onClick: noop },
      { label: "Edit", icon: Pencil, onClick: noop },
      { label: "Duplicate", icon: Copy, onClick: noop },
      { label: "Delete", icon: Trash2, danger: true, separator: true, onClick: noop },
    ]}
  />
);

export const FileActions = () => (
  <ContextMenu
    position={{ x: 24, y: 24 }}
    onClose={noop}
    items={[
      { label: "Download", icon: Download, onClick: noop },
      { label: "Cut", icon: Scissors, onClick: noop },
      { label: "Copy", icon: Copy, onClick: noop },
      { label: "Paste", icon: ClipboardPaste, disabled: true, onClick: noop },
      {
        label: "New",
        icon: FilePlus,
        separator: true,
        submenu: [
          { label: "File", icon: FilePlus, onClick: noop },
          { label: "Folder", icon: FolderPlus, onClick: noop },
        ],
      },
      { label: "Delete", icon: Trash2, danger: true, separator: true, onClick: noop },
    ]}
  />
);
