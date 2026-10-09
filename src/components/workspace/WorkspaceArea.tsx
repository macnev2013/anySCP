import { useRef, useCallback } from "react";
import type { LayoutNode, PaneContent } from "../../types";
import { SplitHandle } from "../terminal/SplitHandle";

/** Renders one leaf pane's content for a given kind (terminal or explorer). */
export type RenderPane = (content: PaneContent, tabId: string) => React.ReactNode;

interface WorkspaceAreaProps {
  node: LayoutNode;
  tabId: string;
  path?: number[];
  /** True when any pane in this workspace is zoomed — hides split handles. */
  zoomed: boolean;
  /** Persist a split's new divider ratio (store-specific). */
  setRatio: (tabId: string, path: number[], ratio: number) => void;
  renderPane: RenderPane;
}

/**
 * Pane-kind-agnostic layout renderer: walks the layout tree, drawing resizable
 * splits and delegating each leaf to `renderPane`. The terminal and the explorer
 * both drive it, passing their own store's zoom/ratio state and pane renderer —
 * one split/resize/zoom implementation for every pane kind.
 */
export function WorkspaceArea({ node, tabId, path = [], zoomed, setRatio, renderPane }: WorkspaceAreaProps) {
  if (node.type === "pane") {
    return <>{renderPane(node.content, tabId)}</>;
  }
  return (
    <WorkspaceSplit
      node={node}
      path={path}
      tabId={tabId}
      zoomed={zoomed}
      setRatio={setRatio}
      renderPane={renderPane}
    />
  );
}

function WorkspaceSplit({
  node,
  path = [],
  tabId,
  zoomed,
  setRatio,
  renderPane,
}: WorkspaceAreaProps & { node: Extract<LayoutNode, { type: "split" }> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isHorizontal = node.direction === "horizontal";
  // Width floor for side-by-side panes so a pane can't be dragged narrower than
  // its full toolbar icon row (home + path + upload×2 + new×2 + refresh + sudo);
  // vertical splits keep the shrink-to-fit min-w-0.
  const paneMinClass = isHorizontal ? "min-w-[18rem]" : "min-w-0";

  // Latest ratio via ref so the drag callback never reads a stale closure.
  const ratioRef = useRef(node.ratio);
  ratioRef.current = node.ratio;

  const handleResize = useCallback(
    (delta: number) => {
      const container = containerRef.current;
      if (!container) return;
      const total = isHorizontal ? container.offsetWidth : container.offsetHeight;
      if (total === 0) return;
      const newRatio = Math.max(0.15, Math.min(0.85, ratioRef.current + delta / total));
      setRatio(tabId, path, newRatio);
    },
    [isHorizontal, path, tabId, setRatio],
  );

  return (
    <div
      ref={containerRef}
      data-testid="split-container"
      data-split-direction={node.direction}
      data-zoomed={zoomed}
      className={`flex h-full w-full gap-0.5 overflow-visible ${isHorizontal ? "flex-row" : "flex-col"}`}
    >
      {/* Horizontal splits get a width floor so a pane can't be dragged so
          narrow its toolbar buttons vanish; vertical splits keep min-h-0. */}
      <div style={{ flex: `${node.ratio} 1 0%` }} className={`${paneMinClass} min-h-0 overflow-hidden`}>
        <WorkspaceArea node={node.children[0]} path={[...path, 0]} tabId={tabId} zoomed={zoomed} setRatio={setRatio} renderPane={renderPane} />
      </div>
      {!zoomed && <SplitHandle direction={node.direction} onResize={handleResize} />}
      <div style={{ flex: `${1 - node.ratio} 1 0%` }} className={`${paneMinClass} min-h-0 overflow-hidden`}>
        <WorkspaceArea node={node.children[1]} path={[...path, 1]} tabId={tabId} zoomed={zoomed} setRatio={setRatio} renderPane={renderPane} />
      </div>
    </div>
  );
}
