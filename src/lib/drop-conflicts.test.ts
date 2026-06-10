import { describe, it, expect } from "vitest";
import { basename, conflictingNames } from "./drop-conflicts";

describe("basename", () => {
  it("handles POSIX and Windows separators", () => {
    expect(basename("/home/user/a.txt")).toBe("a.txt");
    expect(basename("C:\\Users\\me\\b.txt")).toBe("b.txt");
    expect(basename("noslash")).toBe("noslash");
  });
});

describe("conflictingNames", () => {
  it("returns only basenames that already exist remotely", () => {
    const existing = new Set(["a.txt", "c.txt"]);
    expect(conflictingNames(["/x/a.txt", "/x/b.txt", "/x/c.txt"], existing)).toEqual([
      "a.txt",
      "c.txt",
    ]);
  });

  it("de-duplicates two dropped files sharing a basename", () => {
    const existing = new Set(["dup.txt"]);
    // Same basename from two different source dirs → one conflict entry.
    expect(conflictingNames(["/a/dup.txt", "/b/dup.txt"], existing)).toEqual(["dup.txt"]);
  });

  it("returns an empty list when nothing conflicts", () => {
    expect(conflictingNames(["/x/new.txt"], new Set(["other.txt"]))).toEqual([]);
  });
});
