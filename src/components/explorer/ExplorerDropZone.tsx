import { Upload, FolderInput } from "lucide-react";

interface ExplorerDropZoneProps {
  path: string;
  /** True when the cursor is over a directory row, so the drop lands INTO that
   *  folder rather than the current directory. */
  intoFolder?: boolean;
  /** What a drop here does: remote panes "upload", the local pane "copy" (same
   *  machine — no transfer). Drives the wording and icon. */
  action?: "upload" | "copy";
}

export function ExplorerDropZone({ path, intoFolder = false, action = "upload" }: ExplorerDropZoneProps) {
  const folderName = intoFolder ? path.split("/").filter(Boolean).pop() ?? path : null;
  const verb = action === "copy" ? "copy" : "upload";
  const Icon = action === "copy" ? FolderInput : Upload;
  return (
    <div
      className={[
        "absolute inset-0 z-30",
        "flex flex-col items-center justify-center gap-3",
        "bg-accent/10 border-2 border-dashed border-accent rounded-lg m-2",
        "pointer-events-none",
        "animate-[fadeIn_120ms_var(--ease-expo-out)_both]",
      ].join(" ")}
      role="presentation"
      aria-label={`Drop files to ${verb}`}
    >
      <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-accent/10">
        <Icon
          size={26}
          strokeWidth={1.8}
          className="text-accent"
          aria-hidden="true"
        />
      </div>
      <div className="flex flex-col items-center gap-1">
        <p className="text-[length:var(--text-sm)] font-semibold text-accent">
          {folderName ? `Drop to ${verb} into ${folderName}` : `Drop files to ${verb}`}
        </p>
        <p className="font-mono text-[length:var(--text-2xs)] text-text-muted truncate max-w-xs text-center">
          {path}
        </p>
      </div>
    </div>
  );
}
