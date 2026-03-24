import { ChevronRight } from "lucide-react";

interface PathBarProps {
  path: string;
  onNavigate: (path: string) => void;
}

/**
 * Breadcrumb navigation bar that splits a Unix-style path into clickable
 * segments. Clicking a segment navigates to that directory.
 */
export function PathBar({ path, onNavigate }: PathBarProps) {
  // Split path into non-empty segments, preserving root
  const rawSegments = path.split("/").filter((s) => s.length > 0);

  // Build an array of { label, fullPath } items including root
  const segments: { label: string; fullPath: string }[] = [
    { label: "/", fullPath: "/" },
    ...rawSegments.map((seg, i) => ({
      label: seg,
      fullPath: "/" + rawSegments.slice(0, i + 1).join("/"),
    })),
  ];

  return (
    <div
      className="bg-bg-surface border-b border-border px-4 h-10 flex items-center gap-0.5 overflow-x-auto no-select"
      aria-label="Current path"
    >
      {segments.map((seg, index) => {
        const isLast = index === segments.length - 1;
        const isRoot = index === 0;

        return (
          <span key={seg.fullPath} className="flex items-center gap-0.5 shrink-0">
            {/* Chevron separator — skip before the root slash */}
            {!isRoot && (
              <ChevronRight
                size={12}
                strokeWidth={2}
                className="text-text-muted shrink-0"
                aria-hidden="true"
              />
            )}

            <button
              onClick={() => !isLast && onNavigate(seg.fullPath)}
              disabled={isLast}
              title={isLast ? undefined : `Navigate to ${seg.fullPath}`}
              className={[
                "px-1.5 py-0.5 rounded",
                "text-[length:var(--text-sm)] transition-colors duration-[var(--duration-fast)]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isLast
                  ? "text-text-primary font-medium cursor-default"
                  : "text-text-muted hover:text-text-primary hover:bg-bg-subtle cursor-pointer",
              ].join(" ")}
            >
              {seg.label}
            </button>
          </span>
        );
      })}
    </div>
  );
}
