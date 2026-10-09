export type SplitDirection = "horizontal" | "vertical";

export interface SplitNode {
  type: "split";
  direction: SplitDirection;
  /** Position of divider, 0–1 */
  ratio: number;
  children: [LayoutNode, LayoutNode];
}

/**
 * What a leaf pane holds. Panes within one tab are the same kind (terminal tabs
 * → terminal panes; explorer tabs → explorer panes). This union is the seam that
 * lets the shared layout (split / zoom / resize / reconnect) host every kind;
 * the renderer dispatches on `kind`. Every variant carries a `sessionId` so the
 * layout-tree helpers stay content-agnostic (for local it's the pane key).
 */
export type PaneContent =
  | { kind: "terminal"; sessionId: string }
  | { kind: "sftp"; sessionId: string; transport: "sftp" | "scp" }
  | { kind: "s3"; sessionId: string }
  | { kind: "local"; sessionId: string };

export interface PaneNode {
  type: "pane";
  content: PaneContent;
}

export type LayoutNode = SplitNode | PaneNode;
