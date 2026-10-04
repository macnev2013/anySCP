import { ExplorerDropZone } from "anyscp";
import { FileText, Folder } from "lucide-react";
import { Surface } from "./_fixtures";

const ROWS: [string, boolean, string][] = [
  ["archive", true, "—"],
  ["certs", true, "—"],
  ["access.log", false, "48.2 MB"],
  ["error.log", false, "1.3 MB"],
  ["nginx.conf", false, "2.4 KB"],
];

// Static backdrop listing so the overlay reads as sitting over an explorer pane.
function Pane({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative bg-bg-base border border-border rounded-lg overflow-hidden" style={{ width: 600, height: 300 }}>
      <div className="flex flex-col p-2 gap-0.5">
        {ROWS.map(([name, dir, size]) => (
          <div key={name} className="flex items-center gap-2 px-3 py-1.5 text-[length:var(--text-sm)] text-text-secondary">
            {dir ? <Folder size={16} className="text-accent" /> : <FileText size={16} className="text-text-muted" />}
            <span className="flex-1">{name}</span>
            <span className="text-text-muted font-mono text-[length:var(--text-xs)]">{size}</span>
          </div>
        ))}
      </div>
      {children}
    </div>
  );
}

export const CurrentDirectory = () => (
  <Surface><Pane><ExplorerDropZone path="/var/www/html/assets" /></Pane></Surface>
);
export const IntoFolder = () => (
  <Surface><Pane><ExplorerDropZone path="/var/www/html/assets/images" intoFolder /></Pane></Surface>
);
