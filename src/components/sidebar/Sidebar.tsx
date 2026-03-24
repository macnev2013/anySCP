import { useRef, useCallback, useState } from "react";
import { TerminalSquare, Monitor, Braces, FolderOpen, Settings, ArrowUpDown, Plug, History, ChevronsLeft, ChevronsRight } from "lucide-react";
import { useUiStore } from "../../stores/ui-store";
import { useSessionStore } from "../../stores/session-store";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import { useTransferStore } from "../../stores/transfer-store";
import { TransferPopover } from "../transfers/TransferPopover";
import { getStatusString } from "../../utils/format";
import type { ActivePage } from "../../stores/ui-store";

interface NavItem {
  page: ActivePage;
  icon: React.ElementType;
  label: string;
}

const NAV_ITEMS: NavItem[] = [
  { page: "hosts",            icon: Monitor,        label: "Hosts" },
  { page: "terminal",         icon: TerminalSquare, label: "Terminal" },
  { page: "sftp",             icon: FolderOpen,     label: "Explorer" },
  { page: "snippets",         icon: Braces,         label: "Snippets" },
  { page: "port-forwarding",  icon: Plug,           label: "Tunnels" },
  { page: "history",          icon: History,        label: "History" },
];

// ─── Pill button ─────────────────────────────────────────────────────────────

function PillButton({
  icon: Icon,
  label,
  isActive,
  badge,
  expanded,
  onClick,
  buttonRef,
  ariaExpanded,
}: {
  icon: React.ElementType;
  label: string;
  isActive: boolean;
  badge?: number;
  expanded: boolean;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  ariaExpanded?: boolean;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={label}
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        aria-expanded={ariaExpanded}
        className={[
          "relative flex items-center rounded-xl",
          "transition-all duration-[var(--duration-fast)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          expanded ? "w-full gap-2.5 px-2.5 h-9" : "justify-center w-9 h-9",
          isActive
            ? "bg-accent/15 text-accent"
            : "text-text-muted hover:text-text-primary hover:bg-bg-overlay",
        ].join(" ")}
      >
        <Icon size={16} strokeWidth={isActive ? 2 : 1.5} className="shrink-0" />

        {/* Label — expanded only */}
        {expanded && (
          <span className={[
            "text-[length:var(--text-sm)] truncate",
            isActive ? "font-semibold" : "font-medium",
          ].join(" ")}>
            {label}
          </span>
        )}

        {/* Badge */}
        {badge !== undefined && badge > 0 && (
          expanded ? (
            <span className={[
              "ml-auto flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full",
              "text-[length:var(--text-2xs)] font-bold tabular-nums leading-none",
              "bg-accent/15 text-accent",
            ].join(" ")}>
              {badge}
            </span>
          ) : (
            <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[15px] h-[15px] px-0.5 rounded-full bg-accent text-[8px] font-bold text-text-inverse leading-none">
              {badge}
            </span>
          )
        )}
      </button>

      {/* Tooltip — collapsed only */}
      {!expanded && hovered && (
        <div
          className={[
            "absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50",
            "px-2.5 py-1 rounded-lg",
            "bg-bg-overlay border border-border shadow-[var(--shadow-md)]",
            "text-[length:var(--text-xs)] font-medium text-text-primary whitespace-nowrap",
            "animate-[fadeIn_80ms_var(--ease-expo-out)_both]",
            "pointer-events-none",
          ].join(" ")}
        >
          {label}
        </div>
      )}
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export function Sidebar() {
  const activePage = useUiStore((s) => s.activePage);
  const setActivePage = useUiStore((s) => s.setActivePage);
  const expanded = useUiStore((s) => s.sidebarExpanded);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const sessionCount = useSessionStore((s) => s.tabOrder.length);
  const sftpSessionCount = useSftpStore((s) => s.sessions.size);
  const s3SessionCount = useS3Store((s) => s.sessions.size);

  const activeTransferCount = useTransferStore((s) => {
    let count = 0;
    for (const t of s.transfers.values()) {
      const st = getStatusString(t.status);
      if (st === "InProgress" || st === "Queued") count++;
    }
    return count;
  });
  const popoverOpen = useTransferStore((s) => s.popoverOpen);
  const togglePopover = useTransferStore((s) => s.togglePopover);
  const setPopoverOpenStore = useTransferStore((s) => s.setPopoverOpen);
  const transferBtnRef = useRef<HTMLButtonElement>(null);

  const handleTransferClick = useCallback(() => {
    togglePopover();
  }, [togglePopover]);

  const handlePopoverClose = useCallback(() => {
    setPopoverOpenStore(false);
  }, [setPopoverOpenStore]);

  const visibleNavItems = NAV_ITEMS.filter(({ page }) => {
    if (page === "terminal" && sessionCount === 0) return false;
    if (page === "sftp" && sftpSessionCount === 0 && s3SessionCount === 0) return false;
    return true;
  });

  const getBadge = (page: ActivePage): number | undefined => {
    if (page === "terminal" && sessionCount > 0) return sessionCount;
    if (page === "sftp" && (sftpSessionCount + s3SessionCount) > 0) return sftpSessionCount + s3SessionCount;
    return undefined;
  };

  return (
    <>
      <nav
        aria-label="Main navigation"
        className={[
          "no-select flex flex-col shrink-0 h-full py-3",
          "bg-bg-surface border border-border rounded-2xl",
          "transition-[width] duration-[var(--duration-base)] ease-[var(--ease-expo-out)]",
          expanded ? "w-[168px] items-stretch px-2" : "w-[48px] items-center",
        ].join(" ")}
      >
        {/* Nav items */}
        <div className={`flex flex-col gap-1 ${expanded ? "" : "items-center"}`}>
          {visibleNavItems.map(({ page, icon, label }) => (
            <PillButton
              key={page}
              icon={icon}
              label={label}
              isActive={activePage === page}
              badge={getBadge(page)}
              expanded={expanded}
              onClick={() => setActivePage(page)}
            />
          ))}
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bottom actions */}
        <div className={`flex flex-col gap-1 ${expanded ? "" : "items-center"}`}>
          <PillButton
            icon={ArrowUpDown}
            label="Transfers"
            isActive={popoverOpen}
            badge={activeTransferCount || undefined}
            expanded={expanded}
            onClick={handleTransferClick}
            buttonRef={transferBtnRef}
            ariaExpanded={popoverOpen}
          />

          <PillButton
            icon={Settings}
            label="Settings"
            isActive={activePage === "settings"}
            expanded={expanded}
            onClick={() => setActivePage("settings")}
          />

          {/* Expand/collapse */}
          <PillButton
            icon={expanded ? ChevronsLeft : ChevronsRight}
            label={expanded ? "Collapse" : "Expand"}
            isActive={false}
            expanded={expanded}
            onClick={toggleSidebar}
          />
        </div>
      </nav>

      {/* Transfer popover */}
      {popoverOpen && (
        <TransferPopover
          anchorRect={transferBtnRef.current?.getBoundingClientRect() ?? null}
          onClose={handlePopoverClose}
        />
      )}
    </>
  );
}
