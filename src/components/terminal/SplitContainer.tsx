import { useRef, useCallback } from "react";
import type { SplitNode } from "../../types";
import { useSessionStore } from "../../stores/session-store";
import { SplitHandle } from "./SplitHandle";
import { TerminalArea } from "./TerminalArea";

interface SplitContainerProps {
  node: SplitNode;
  path: number[];
  tabId: string;
}

export function SplitContainer({ node, path, tabId }: SplitContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const updateSplitRatio = useSessionStore((s) => s.updateSplitRatio);
  const isZoomed = useSessionStore((s) => s.zoomedPaneId !== null);

  const isHorizontal = node.direction === "horizontal";

  // Keep a ref to the latest ratio so the drag callback always reads the
  // current value, not a stale closure capture.
  const ratioRef = useRef(node.ratio);
  ratioRef.current = node.ratio;

  const handleResize = useCallback(
    (delta: number) => {
      const container = containerRef.current;
      if (!container) return;

      const total = isHorizontal ? container.offsetWidth : container.offsetHeight;
      if (total === 0) return;

      const ratioDelta = delta / total;
      const newRatio = Math.max(0.15, Math.min(0.85, ratioRef.current + ratioDelta));
      updateSplitRatio(tabId, path, newRatio);
    },
    [isHorizontal, path, tabId, updateSplitRatio],
  );

  return (
    <div
      ref={containerRef}
      className={`relative flex h-full w-full gap-0.5 overflow-hidden ${isHorizontal ? "flex-row" : "flex-col"}`}
    >
      <div style={{ flex: `${node.ratio} 1 0%` }} className="min-w-0 min-h-0 overflow-hidden">
        <TerminalArea node={node.children[0]} path={[...path, 0]} tabId={tabId} />
      </div>
      {!isZoomed && <SplitHandle direction={node.direction} onResize={handleResize} />}
      <div style={{ flex: `${1 - node.ratio} 1 0%` }} className="min-w-0 min-h-0 overflow-hidden">
        <TerminalArea node={node.children[1]} path={[...path, 1]} tabId={tabId} />
      </div>
    </div>
  );
}
