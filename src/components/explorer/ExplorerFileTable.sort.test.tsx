import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { useState } from "react";
import { render, fireEvent, screen } from "@testing-library/react";
import { ExplorerFileTable } from "./ExplorerFileTable";
import { createSftpProvider } from "../../providers/sftp-provider";
import type { ExplorerEntry } from "../../types/explorer";

function entry(over: Partial<ExplorerEntry> = {}): ExplorerEntry {
  return {
    name: "notes.txt",
    id: "/home/notes.txt",
    entryType: "File",
    size: 12,
    modified: null,
    permissionsDisplay: "rw-r--r--",
    permissions: 0o644,
    isSymlink: false,
    storageClass: null,
    ...over,
  };
}

const ENTRIES: ExplorerEntry[] = [
  entry({ name: "big.iso", id: "/home/big.iso", size: 5_000_000, modified: 100 }),
  entry({ name: "old.log", id: "/home/old.log", size: 10, modified: 50 }),
  entry({ name: "new.txt", id: "/home/new.txt", size: 300, modified: 900 }),
  entry({ name: "sub", id: "/home/sub", entryType: "Directory", size: 0, modified: 500 }),
];

/** Table plus lifted sort state, wired the same way ExplorerView wires it. */
function Harness({ initialBy = "name", initialAsc = true }: { initialBy?: "name" | "size" | "modified"; initialAsc?: boolean }) {
  const [sort, setSort] = useState({ by: initialBy, asc: initialAsc });
  return (
    <ExplorerFileTable
      provider={createSftpProvider("s")}
      entries={ENTRIES}
      sortBy={sort.by}
      sortAsc={sort.asc}
      onSortChange={(by, asc) => setSort({ by, asc })}
      clipboard={null}
      onSetClipboard={() => {}}
      onNavigate={() => {}}
      onDownload={() => {}}
      onDelete={async () => {}}
      onEditInEditor={() => {}}
      currentPath="/home"
      loading={false}
    />
  );
}

function rowOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-entry-name]")).map(
    (el) => el.getAttribute("data-entry-name") ?? "",
  );
}

describe("ExplorerFileTable — column sorting", () => {
  it("sorts by name ascending by default, directories first", () => {
    const { container } = render(<Harness />);
    expect(rowOrder(container)).toEqual(["sub", "big.iso", "new.txt", "old.log"]);
  });

  it("clicking Size sorts files by size, ascending then descending", () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByTestId("explorer-sort-size"));
    expect(rowOrder(container)).toEqual(["sub", "old.log", "new.txt", "big.iso"]);
    fireEvent.click(screen.getByTestId("explorer-sort-size"));
    expect(rowOrder(container)).toEqual(["sub", "big.iso", "new.txt", "old.log"]);
  });

  it("clicking Modified sorts files by mtime, ascending then descending", () => {
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByTestId("explorer-sort-modified"));
    expect(rowOrder(container)).toEqual(["sub", "old.log", "big.iso", "new.txt"]);
    fireEvent.click(screen.getByTestId("explorer-sort-modified"));
    expect(rowOrder(container)).toEqual(["sub", "new.txt", "big.iso", "old.log"]);
  });

  it("switching columns resets to ascending", () => {
    const { container } = render(<Harness initialBy="size" initialAsc={false} />);
    fireEvent.click(screen.getByTestId("explorer-sort-modified"));
    expect(rowOrder(container)).toEqual(["sub", "old.log", "big.iso", "new.txt"]);
  });
});
