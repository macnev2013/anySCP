import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, Cloud, HardDrive, Maximize2, Minimize2 } from "lucide-react";
import { Explorer } from "../explorer/Explorer";
import { S3Explorer } from "../s3/S3Explorer";
import { createSftpProvider } from "../../providers/sftp-provider";
import { createLocalProvider } from "../../providers/local-provider";
import { useSftpStore } from "../../stores/sftp-store";
import { useS3Store } from "../../stores/s3-store";
import { useSettingsStore } from "../../stores/settings-store";
import { WorkspaceArea } from "../workspace/WorkspaceArea";
import type { Transport } from "../../lib/explorer-transport";
import type { LayoutNode, PaneContent } from "../../types";
import type {
  ExplorerEntry,
  PaneRuntime,
  CrossPaneTarget,
} from "../../types/explorer";
import {
  classifyMoveOutcome,
  planMoveSources,
  reconcileFocusedId,
  CrossPaneMoveTracker,
  type MoveDecision,
} from "../../lib/cross-pane-move";

interface ExplorerPageProps {
  /** SFTP/SCP transport session id (both live in the sftp store). */
  sftpSessionId?: string;
  /** Defaults to "sftp"; "scp" when the host fell back to SCP. */
  transport?: Transport;
  s3SessionId?: string;
  /** Whether this tab is the active/visible one. Explorer tabs stay mounted
   *  (issue #17), so document-level listeners must only fire for the active one. */
  isActive?: boolean;
}

/**
 * A bordered explorer pane (header + content) — the explorer's equivalent of
 * TerminalPane, rendered by WorkspaceArea for each leaf. Fills via `h-full`
 * (not flex-1) so it works inside a split child, which is a plain block. In
 * dual-pane it shows an accent border when focused; a mousedown focuses it.
 */
function ExplorerPane({
  icon: Icon,
  label,
  transport,
  highlighted,
  onActivate,
  zoomed,
  onToggleZoom,
  children,
}: {
  icon: React.ElementType;
  label: string;
  transport?: string;
  highlighted: boolean;
  onActivate: () => void;
  /** True when this pane is maximized over its sibling. */
  zoomed?: boolean;
  /** Present only in dual-pane — toggles this pane's zoom. */
  onToggleZoom?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onMouseDownCapture={onActivate}
      className={[
        // Solid background so a zoomed pane fully hides the sibling beneath it —
        // the header is bg-bg-surface/80 (semi-transparent), which would
        // otherwise let the sibling's header bleed through the overlay.
        "flex flex-col min-h-0 rounded-lg overflow-hidden border bg-bg-base transition-colors duration-[var(--duration-fast)]",
        // Zoom: fill the whole explorer area over the sibling, same pattern as
        // TerminalPane (no remount, no layout-store).
        zoomed ? "absolute inset-2 z-30 border-accent/50" : "h-full",
        !zoomed && (highlighted ? "border-accent/50" : "border-border/60"),
      ].join(" ")}
    >
      {/* Pane header — matching terminal pane style */}
      <div className="flex items-center h-8 px-2.5 gap-2.5 shrink-0 no-select bg-bg-surface/80 border-b border-border/60">
        <Icon size={14} strokeWidth={1.8} className="shrink-0 text-status-connected" aria-hidden="true" />
        <span className="text-[11px] font-mono truncate flex-1 min-w-0 text-text-primary leading-none" title={label}>
          {label}
        </span>
        {onToggleZoom && (
          <button
            type="button"
            onClick={onToggleZoom}
            aria-label={zoomed ? "Unzoom pane" : "Zoom pane"}
            title={zoomed ? "Restore" : "Maximize"}
            className="shrink-0 flex items-center justify-center w-5 h-5 rounded text-text-muted hover:text-text-primary hover:bg-bg-subtle transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {zoomed ? (
              <Minimize2 size={12} strokeWidth={2} aria-hidden="true" />
            ) : (
              <Maximize2 size={12} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 bg-bg-base" data-explorer-transport={transport}>
        {children}
      </div>
    </div>
  );
}

export function ExplorerPage({ sftpSessionId, transport = "sftp", s3SessionId, isActive = true }: ExplorerPageProps) {
  const sftpSession = useSftpStore((s) => sftpSessionId ? s.sessions.get(sftpSessionId) : null);
  const s3Session = useS3Store((s) => s3SessionId ? s.sessions.get(s3SessionId) : null);
  const dualPane = useSettingsStore((s) => s.explorerDualPane);

  const baseLabel = sftpSession?.label ?? s3Session?.label ?? "Explorer";
  // Surface SCP fallback subtly so the user understands why server-side
  // metadata (timestamps, etc.) may look slightly different.
  const label = sftpSessionId && transport === "scp" ? `${baseLabel} · SCP` : baseLabel;

  const sftpProvider = useMemo(
    () => (sftpSessionId ? createSftpProvider(sftpSessionId, transport) : null),
    [sftpSessionId, transport],
  );

  // Left pane = local filesystem (WinSCP-style), scoped per tab so each keeps
  // its own cwd. Only created when dual-pane is on.
  const remoteId = sftpSessionId ?? s3SessionId ?? "";
  const localKey = `local:${remoteId}`;
  const localProvider = useMemo(
    () => (dualPane ? createLocalProvider(localKey) : null),
    [dualPane, localKey],
  );

  // Divider position + which pane is focused. Only the focused pane is "active"
  // (its document-level listeners fire), so the two don't fight over shortcuts.
  const [ratio, setRatio] = useState(0.5);
  const [focusedId, setFocusedId] = useState(remoteId);
  // A session swap (e.g. the sudo toggle) changes remoteId — and the pane ids
  // with it — so a focusedId seeded from the old id would match neither pane,
  // leaving none "active" and killing document-level shortcuts. Re-point focus
  // at a pane that still exists.
  useEffect(() => {
    setFocusedId((cur) => reconcileFocusedId(cur, localKey, remoteId));
  }, [localKey, remoteId]);
  // Which pane (if any) is maximized over its sibling. Dual-pane only.
  const [zoomedPaneKey, setZoomedPaneKey] = useState<string | null>(null);

  // ─── Cross-pane transfer coordinator ──────────────────────────────────────
  // Both panes register a runtime here; the coordinator drives transfers by
  // calling the destination runtime's upload/download entry points. Works for
  // local↔SFTP/SCP AND local↔S3 — the coordinator is transport-agnostic (it only
  // calls uploadInto/downloadTo, which every remote supports).
  const crossPaneEnabled = dualPane && (!!sftpProvider || !!s3SessionId);
  const runtimes = useRef<{ local: PaneRuntime | null; remote: PaneRuntime | null }>({
    local: null,
    remote: null,
  });
  const registerLocalRuntime = useCallback((rt: PaneRuntime | null) => {
    runtimes.current.local = rt;
  }, []);
  const registerRemoteRuntime = useCallback((rt: PaneRuntime | null) => {
    runtimes.current.remote = rt;
  }, []);

  // Reconciles cross-pane MOVE source deletions: the source is deleted only once
  // its transfer has actually completed, whichever way the "id registered" and
  // "transfer finished" signals happen to interleave. This is what makes a move
  // safe. See CrossPaneMoveTracker for the ordering the tracker guards against.
  const moveTracker = useRef(new CrossPaneMoveTracker());

  // Act on a tracker decision: delete the source now, or (for a terminal that
  // beat its registration) expire the stash so unrelated transfers can't pile up.
  const applyMoveDecision = useCallback((decision: MoveDecision) => {
    if (decision.action === "delete") {
      const { move } = decision;
      // Slight delay so the destination pane's own completion refresh settles first.
      setTimeout(() => runtimes.current[move.role]?.remove?.([move.entry]), 300);
    } else if (decision.action === "stash") {
      const { id } = decision;
      setTimeout(() => moveTracker.current.forgetEarly(id), 5_000);
    }
  }, []);

  // Core cross-pane transfer (local↔remote), shared by copy and move. `onEnqueued`
  // (move only) receives the queued transfer ids so the source can be deleted once
  // each completes. Copy passes nothing, so no source is ever removed.
  const transfer = useCallback(
    (
      fromRole: "local" | "remote",
      entries: ExplorerEntry[],
      onEnqueued?: (ids: string[]) => void,
      // Destination dir override (a folder/".." the drop landed on); omitted =
      // the destination pane's cwd.
      targetDir?: string,
    ) => {
      if (entries.length === 0) return;
      const { local, remote } = runtimes.current;
      if (!local || !remote) return;
      if (fromRole === "local") {
        // local → remote: upload into the remote pane's target dir (the remote
        // pane's uploadInto runs its own overwrite guard).
        remote.uploadInto?.(entries.map((e) => e.id), onEnqueued, targetDir);
      } else {
        // remote → local: let the local pane guard against clobbering its own
        // files (same overwrite dialog as an upload), then download into it.
        const run = (localDir: string) => remote.downloadTo?.(entries, localDir, onEnqueued);
        if (local.receiveDownload) local.receiveDownload(entries, run, targetDir);
        else run(targetDir ?? local.getCurrentPath());
      }
    },
    [],
  );

  const transferCopy = useCallback(
    (fromRole: "local" | "remote", entries: ExplorerEntry[], targetDir?: string) =>
      transfer(fromRole, entries, undefined, targetDir),
    [transfer],
  );

  const transferMove = useCallback(
    (fromRole: "local" | "remote", entries: ExplorerEntry[], targetDir?: string) => {
      transfer(fromRole, entries, (ids) => {
        const plan = planMoveSources(ids, entries);
        if (!plan) {
          // Count mismatch: can't pair ids→sources safely, so record no pending
          // deletions — the move degrades to a copy, never a wrong delete.
          console.warn("cross-pane move: transfer id/entry count mismatch — leaving sources in place");
          return;
        }
        plan.forEach((entry, id) => {
          // The transfer may already have finished before this callback ran
          // (fast transfer beats the enqueue invoke response); the tracker
          // honours such an early outcome instead of awaiting a spent event.
          applyMoveDecision(moveTracker.current.register(id, { role: fromRole, entry }));
        });
      }, targetDir);
    },
    [transfer],
  );

  // Shared cross-pane clipboard: the single most-recent clipboard action across
  // both panes (copy OR cut), tagged with its source role. `syncClipboard` writes
  // it on every copy/cut; each pane's `pasteFromSibling` reads it and, when the
  // action came from the OTHER pane, drives a copy (copy) or a move (cut). Tracking
  // cuts here — not just copies — is what stops a stale per-pane clipboard from
  // hijacking a paste after a cut in the sibling.
  const crossClipboard = useRef<
    { role: "local" | "remote"; operation: "copy" | "cut"; entries: ExplorerEntry[] } | null
  >(null);
  const hasSiblingClipboard = useCallback(
    (paneRole: "local" | "remote") => {
      const clip = crossClipboard.current;
      return !!clip && clip.role !== paneRole;
    },
    [],
  );
  const pasteFromSibling = useCallback(
    (paneRole: "local" | "remote") => {
      const clip = crossClipboard.current;
      if (!clip || clip.role === paneRole) return false;
      if (clip.operation === "cut") {
        transferMove(clip.role, clip.entries);
        crossClipboard.current = null; // a cut moves once, then it's spent
        // Clear the source pane's own clipboard too, so a later same-pane paste
        // there doesn't try to move the now-relocated files.
        runtimes.current[clip.role]?.clearClipboard?.();
      } else {
        transferCopy(clip.role, clip.entries);
      }
      return true;
    },
    [transferCopy, transferMove],
  );

  // Each pane's cross-pane target is the same shape mirrored by role; build both
  // from one factory so the wiring can't drift between the two sides.
  const makeCrossPane = useCallback(
    (role: "local" | "remote", siblingLabel: string): CrossPaneTarget => ({
      siblingLabel,
      copyTo: (entries, targetDir) => transferCopy(role, entries, targetDir),
      moveTo: (entries, targetDir) => transferMove(role, entries, targetDir),
      syncClipboard: (clip) => {
        crossClipboard.current = clip
          ? { role, operation: clip.operation, entries: clip.entries }
          : null;
      },
      pasteFromSibling: () => pasteFromSibling(role),
      hasSiblingClipboard: () => hasSiblingClipboard(role),
    }),
    [transferCopy, transferMove, pasteFromSibling, hasSiblingClipboard],
  );
  const localCrossPane = useMemo<CrossPaneTarget | undefined>(
    () => (crossPaneEnabled ? makeCrossPane("local", label) : undefined),
    [crossPaneEnabled, makeCrossPane, label],
  );
  const remoteCrossPane = useMemo<CrossPaneTarget | undefined>(
    () => (crossPaneEnabled ? makeCrossPane("remote", "Local") : undefined),
    [crossPaneEnabled, makeCrossPane],
  );

  // E2E test hook — drive the cross-pane coordinator directly (both runtimes are
  // registered by the time both panes mount), so specs can exercise the real
  // transfer + move-source-deletion against a live server without the flaky
  // pointer plumbing of a cross-pane drag. Only present while cross-pane is live.
  useEffect(() => {
    if (!crossPaneEnabled) return;
    const w = window as unknown as {
      __e2eCrossPaneCopy?: (from: "local" | "remote", entries: ExplorerEntry[], targetDir?: string) => void;
      __e2eCrossPaneMove?: (from: "local" | "remote", entries: ExplorerEntry[], targetDir?: string) => void;
    };
    w.__e2eCrossPaneCopy = (from, entries, targetDir) => transferCopy(from, entries, targetDir);
    w.__e2eCrossPaneMove = (from, entries, targetDir) => transferMove(from, entries, targetDir);
    return () => {
      w.__e2eCrossPaneCopy = undefined;
      w.__e2eCrossPaneMove = undefined;
    };
  }, [crossPaneEnabled, transferCopy, transferMove]);

  // The remote pane self-refreshes on upload completion; downloads land in the
  // local pane, whose provider emits no transfer events — so refresh it here
  // when a download for this session finishes. The channel + id field track the
  // transport, since an SCP-fallback remote emits `scp:transfer`/`scp_session_id`.
  useEffect(() => {
    // The remote is either SFTP/SCP or S3; each emits on its own channel with its
    // own session-id field. An SCP-fallback remote emits `scp:transfer`.
    const remoteSessionId = sftpSessionId ?? s3SessionId;
    if (!crossPaneEnabled || !remoteSessionId) return;
    const channel = sftpSessionId ? `${transport}:transfer` : "s3:transfer";
    const idField = sftpSessionId ? `${transport}_session_id` : "s3_session_id";
    let aborted = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (aborted) return;
        const unsub = await listen<{
          transfer_id?: string;
          direction?: string;
          // Unit variants serialize as strings ("Completed", "Cancelled", …);
          // the `Failed(String)` variant serializes as an object `{Failed: "…"}`.
          status?: string | Record<string, unknown>;
          [k: string]: unknown;
        }>(channel, (event) => {
          const p = event.payload;
          if (p[idField] !== remoteSessionId) return;

          const outcome = classifyMoveOutcome(p.status);

          // Cross-pane MOVE: once a tracked transfer lands, delete its source;
          // if it failed or was cancelled, drop it undeleted (never lose data).
          const id = typeof p.transfer_id === "string" ? p.transfer_id : undefined;
          if (id && (outcome === "completed" || outcome === "failed")) {
            applyMoveDecision(moveTracker.current.terminal(id, outcome));
          }

          // A completed download → refresh the local pane (see above).
          if (p.direction === "Download" && outcome === "completed") {
            setTimeout(() => runtimes.current.local?.refresh(), 300);
          }
        });
        if (aborted) unsub();
        else unlisten = unsub;
      } catch {
        /* Not in a Tauri context */
      }
    })();
    return () => {
      aborted = true;
      unlisten?.();
    };
  }, [crossPaneEnabled, sftpSessionId, s3SessionId, transport]);

  const remoteContent: PaneContent = sftpSessionId
    ? { kind: "sftp", sessionId: sftpSessionId, transport }
    : { kind: "s3", sessionId: s3SessionId ?? "" };

  // Dual-pane is just a horizontal split of [local, remote]; single is one pane.
  const layout: LayoutNode = dualPane
    ? {
        type: "split",
        direction: "horizontal",
        ratio,
        children: [
          { type: "pane", content: { kind: "local", sessionId: localKey } },
          { type: "pane", content: remoteContent },
        ],
      }
    : { type: "pane", content: remoteContent };

  const renderPane = (content: PaneContent) => {
    const paneActive = isActive && (!dualPane || content.sessionId === focusedId);
    const highlighted = dualPane && content.sessionId === focusedId;
    const onActivate = () => setFocusedId(content.sessionId);
    const zoomed = dualPane && zoomedPaneKey === content.sessionId;
    // Zoom is only meaningful with a sibling to maximize over.
    const onToggleZoom = dualPane
      ? () => {
          setFocusedId(content.sessionId);
          setZoomedPaneKey((k) => (k === content.sessionId ? null : content.sessionId));
        }
      : undefined;

    // Props shared by every pane body. The chrome (icon/label/transport) and the
    // body node are the only things that vary by kind — so pick those, then wrap
    // in a single <ExplorerPane> rather than repeating the whole shell 3×.
    const bodyProps = { isActive: paneActive, tabActive: isActive, dense: dualPane && !zoomed };
    let pane: { icon: React.ElementType; label: string; transport: string; body: React.ReactNode } | null = null;
    if (content.kind === "local") {
      pane = {
        icon: HardDrive,
        label: "Local",
        transport: "local",
        body: localProvider && (
          <Explorer provider={localProvider} registerRuntime={registerLocalRuntime} crossPane={localCrossPane} {...bodyProps} />
        ),
      };
    } else if (content.kind === "s3") {
      pane = {
        icon: Cloud,
        label,
        transport: "s3",
        body: (
          <S3Explorer sessionId={content.sessionId} registerRuntime={registerRemoteRuntime} crossPane={remoteCrossPane} {...bodyProps} />
        ),
      };
    } else if (content.kind === "sftp") {
      pane = {
        icon: FolderOpen,
        label,
        transport: content.transport,
        body: sftpProvider && (
          <Explorer provider={sftpProvider} registerRuntime={registerRemoteRuntime} crossPane={remoteCrossPane} {...bodyProps} />
        ),
      };
    }
    if (!pane) return null; // terminal panes never occur in an explorer tab

    return (
      <ExplorerPane
        icon={pane.icon}
        label={pane.label}
        transport={pane.transport}
        highlighted={highlighted}
        onActivate={onActivate}
        zoomed={zoomed}
        onToggleZoom={onToggleZoom}
      >
        {pane.body}
      </ExplorerPane>
    );
  };

  return (
    // `relative` so a zoomed pane's `absolute inset-2` fills exactly this p-2
    // content area (over its sibling).
    <div className="relative flex flex-col h-full p-2">
      <WorkspaceArea
        node={layout}
        tabId={remoteId}
        zoomed={dualPane && zoomedPaneKey !== null}
        setRatio={(_tabId, _path, r) => setRatio(r)}
        renderPane={renderPane}
      />
    </div>
  );
}
