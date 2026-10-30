import { describe, expect, it } from "vitest";
import { filterExplorerEntries } from "./explorer-visibility";
import { toS3ExplorerEntry } from "../providers/s3-provider";

describe("Explorer visibility", () => {
  it("filters names only, including directories and symlinks, without changing the complete list", () => {
    const entries = [
      { name: ".env", id: "/.config/.env", entryType: "File" },
      { name: ".git", id: "/.config/.git", entryType: "Directory" },
      { name: ".link", id: "/.config/.link", entryType: "Symlink" },
      { name: "report.v1.txt", id: "/.config/report.v1.txt", entryType: "File" },
    ];
    expect(filterExplorerEntries(entries, false)).toEqual({ visibleEntries: [entries[3]], hiddenCount: 3 });
    expect(filterExplorerEntries(entries, true).visibleEntries).toBe(entries);
    expect(entries).toHaveLength(4);
  });

  it("handles S3 prefix display names and normal children under hidden prefixes", () => {
    const entries = [
      { name: ".config", key: ".parent/.config/", entry_type: "Directory" as const },
      { name: "config", key: ".parent/config/", entry_type: "Directory" as const },
    ].map((entry) => toS3ExplorerEntry({ ...entry, size: 0, last_modified: null, storage_class: null }));
    expect(filterExplorerEntries(entries, false)).toEqual({ visibleEntries: [entries[1]], hiddenCount: 1 });
  });
});
