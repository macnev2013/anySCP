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

  const isHorizontal = node.direction === "horizontal";

  const handleResize = useCallback(
    (delta: number) => {
      const container = containerRef.current;
      if (!container) return;

      const total = isHorizontal ? container.offsetWidth : container.offsetHeight;
      if (total === 0) return;

      const ratioDelta = delta / total;
      const newRatio = Math.max(0.15, Math.min(0.85, node.ratio + ratioDelta));
      updateSplitRatio(tabId, path, newRatio);
    },
    [isHorizontal, node.ratio, path, tabId, updateSplitRatio],
  );

  const firstPercent = `${node.ratio * 100}%`;
  const secondPercent = `${(1 - node.ratio) * 100}%`;

  return (
    <div
      ref={containerRef}
      className={`flex h-full w-full ${isHorizontal ? "flex-row" : "flex-col"}`}
    >
      <div style={{ [isHorizontal ? "width" : "height"]: firstPercent }} className="min-w-0 min-h-0">
        <TerminalArea node={node.children[0]} path={[...path, 0]} tabId={tabId} />
      </div>
      <SplitHandle direction={node.direction} onResize={handleResize} />
      <div style={{ [isHorizontal ? "width" : "height"]: secondPercent }} className="min-w-0 min-h-0">
        <TerminalArea node={node.children[1]} path={[...path, 1]} tabId={tabId} />
      </div>
    </div>
  );
}
