export type SplitDirection = "horizontal" | "vertical";

export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  /** Position of divider, 0–1 */
  ratio: number;
  children: [LayoutNode, LayoutNode];
}

export interface PaneNode {
  type: "pane";
  sessionId: string;
}

export type LayoutNode = SplitNode | PaneNode;
