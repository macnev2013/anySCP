import { describe, it, expect } from "vitest";
import type { LayoutNode } from "../types";
import {
  replacePane,
  removePane,
  updateRatioAtPath,
  countPanes,
  getTopDirection,
  containsSession,
  collectSessionIds,
} from "./layout-tree";

const pane = (id: string): LayoutNode => ({ type: "pane", content: { kind: "terminal", sessionId: id } });
const hsplit = (a: LayoutNode, b: LayoutNode, ratio = 0.5): LayoutNode => ({
  type: "split",
  direction: "horizontal",
  ratio,
  children: [a, b],
});

describe("layout-tree", () => {
  it("counts panes and reads the top direction", () => {
    expect(countPanes(pane("a"))).toBe(1);
    expect(getTopDirection(pane("a"))).toBeNull();
    const tree = hsplit(pane("a"), hsplit(pane("b"), pane("c")));
    expect(countPanes(tree)).toBe(3);
    expect(getTopDirection(tree)).toBe("horizontal");
  });

  it("finds and collects sessions in order", () => {
    const tree = hsplit(pane("a"), hsplit(pane("b"), pane("c")));
    expect(collectSessionIds(tree)).toEqual(["a", "b", "c"]);
    expect(containsSession(tree, "b")).toBe(true);
    expect(containsSession(tree, "z")).toBe(false);
  });

  it("replaces a pane in place", () => {
    const tree = hsplit(pane("a"), pane("b"));
    const next = replacePane(tree, "b", pane("x"));
    expect(collectSessionIds(next)).toEqual(["a", "x"]);
  });

  it("removes a pane and collapses its split", () => {
    const tree = hsplit(pane("a"), hsplit(pane("b"), pane("c")));
    // Removing b collapses the inner split down to just c.
    const next = removePane(tree, "b");
    expect(next).not.toBeNull();
    expect(collectSessionIds(next!)).toEqual(["a", "c"]);
    expect(countPanes(next!)).toBe(2);
    // Removing the only pane yields null (empty tree).
    expect(removePane(pane("a"), "a")).toBeNull();
  });

  it("updates the ratio at a path without touching others", () => {
    const tree = hsplit(pane("a"), hsplit(pane("b"), pane("c"), 0.5), 0.5);
    const next = updateRatioAtPath(tree, [1], 0.8) as Extract<LayoutNode, { type: "split" }>;
    expect(next.ratio).toBe(0.5); // root unchanged
    expect((next.children[1] as Extract<LayoutNode, { type: "split" }>).ratio).toBe(0.8);
  });
});
