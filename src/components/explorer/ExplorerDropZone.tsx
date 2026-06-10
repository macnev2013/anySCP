import { Upload } from "lucide-react";

interface ExplorerDropZoneProps {
  path: string;
  /** True when the cursor is over a directory row, so the drop uploads INTO
   *  that folder rather than the current directory. */
  intoFolder?: boolean;
}

export function ExplorerDropZone({ path, intoFolder = false }: ExplorerDropZoneProps) {
  const folderName = intoFolder ? path.split("/").filter(Boolean).pop() ?? path : null;
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
      aria-label="Drop files to upload"
    >
      <div className="flex items-center justify-center w-12 h-12 rounded-xl bg-accent/10">
        <Upload
          size={26}
          strokeWidth={1.8}
          className="text-accent"
          aria-hidden="true"
        />
      </div>
      <div className="flex flex-col items-center gap-1">
        <p className="text-[length:var(--text-sm)] font-semibold text-accent">
          {folderName ? `Drop to upload into ${folderName}` : "Drop files to upload"}
        </p>
        <p className="font-mono text-[length:var(--text-2xs)] text-text-muted truncate max-w-xs text-center">
          {path}
        </p>
      </div>
    </div>
  );
}
