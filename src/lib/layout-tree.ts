import type { LayoutNode, SplitDirection } from "../types";

// Pure operations on a pane layout tree. Kept content-agnostic (they only ever
// read `content.sessionId`, present on every pane kind) so the split / zoom /
// resize machinery is shared by terminal and explorer panes alike.

/** Replace the pane holding `sessionId` with `replacement`. */
export function replacePane(
  node: LayoutNode,
  targetSessionId: string,
  replacement: LayoutNode,
): LayoutNode {
  if (node.type === "pane") {
    return node.content.sessionId === targetSessionId ? replacement : node;
  }
  return {
    ...node,
    children: [
      replacePane(node.children[0], targetSessionId, replacement),
      replacePane(node.children[1], targetSessionId, replacement),
    ],
  };
}

/** Remove the pane holding `sessionId`, collapsing its enclosing split.
 *  Returns null if the whole tree was that single pane. */
export function removePane(node: LayoutNode, targetSessionId: string): LayoutNode | null {
  if (node.type === "pane") {
    return node.content.sessionId === targetSessionId ? null : node;
  }
  const [left, right] = node.children;
  if (left.type === "pane" && left.content.sessionId === targetSessionId) return right;
  if (right.type === "pane" && right.content.sessionId === targetSessionId) return left;
  const newLeft = removePane(left, targetSessionId);
  const newRight = removePane(right, targetSessionId);
  if (newLeft === null) return right;
  if (newRight === null) return left;
  return { ...node, children: [newLeft, newRight] };
}

/** Set the ratio of the split at `path` (root-relative child indices). */
export function updateRatioAtPath(node: LayoutNode, path: number[], ratio: number): LayoutNode {
  if (path.length === 0 && node.type === "split") {
    return { ...node, ratio };
  }
  if (node.type === "pane" || path.length === 0) return node;
  const [idx, ...rest] = path;
  const newChildren = [...node.children] as [LayoutNode, LayoutNode];
  newChildren[idx] = updateRatioAtPath(newChildren[idx], rest, ratio);
  return { ...node, children: newChildren };
}

/** Count leaf panes in a layout tree. */
export function countPanes(node: LayoutNode): number {
  if (node.type === "pane") return 1;
  return countPanes(node.children[0]) + countPanes(node.children[1]);
}

/** Top-level split direction, or null for a single pane. */
export function getTopDirection(node: LayoutNode): SplitDirection | null {
  if (node.type === "pane") return null;
  return node.direction;
}

/** Does the tree contain a pane for `sessionId`? */
export function containsSession(node: LayoutNode, sessionId: string): boolean {
  if (node.type === "pane") return node.content.sessionId === sessionId;
  return containsSession(node.children[0], sessionId) || containsSession(node.children[1], sessionId);
}

/** Every session id in the tree, left-to-right. */
export function collectSessionIds(node: LayoutNode): string[] {
  if (node.type === "pane") return [node.content.sessionId];
  return [...collectSessionIds(node.children[0]), ...collectSessionIds(node.children[1])];
}
