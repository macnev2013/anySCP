import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilePropertiesDialog } from "./FilePropertiesDialog";
import type { ExplorerEntry, ProviderCapabilities } from "../../types/explorer";

const CAPS: ProviderCapabilities = {
  canRename: true,
  canCreateFile: true,
  canCreateFolder: true,
  canDelete: true,
  canUpload: true,
  canDownload: true,
  canDragDropUpload: true,
  canInternalDragMove: true,
  canCopyPaste: true,
  canEditInEditor: true,
  canGetInfo: true,
  hasPermissions: true,
  hasStorageClass: false,
  canPresignUrl: false,
};

function makeEntry(over: Partial<ExplorerEntry> = {}): ExplorerEntry {
  return {
    name: "file.txt",
    id: "/home/user/file.txt",
    entryType: "File",
    size: 123,
    modified: null,
    permissionsDisplay: "rwxr-xr-x", // 0o755
    permissions: 0o755,
    isSymlink: false,
    storageClass: null,
    ...over,
  };
}

const octalInput = () => screen.getByTestId("perm-octal") as HTMLInputElement;
const applyBtn = () => screen.getByTestId("file-properties-apply") as HTMLButtonElement;

describe("FilePropertiesDialog", () => {
  it("applies 0o755 when pasting the conventional '0755' form (not 0o075)", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      <FilePropertiesDialog
        entry={makeEntry({ permissionsDisplay: "rw-r--r--", permissions: 0o644 })}
        capabilities={CAPS}
        onApplyPermissions={onApply}
        onClose={() => {}}
      />,
    );

    fireEvent.change(octalInput(), { target: { value: "0755" } });
    expect(octalInput().value).toBe("755");
    expect((screen.getByTestId("perm-ownerX") as HTMLInputElement).checked).toBe(true);

    fireEvent.click(applyBtn());
    await vi.waitFor(() => expect(onApply).toHaveBeenCalled());
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ id: "/home/user/file.txt" }), 0o755, false);
  });

  it("preserves the setuid bit when editing a setuid file's rwx", async () => {
    const onApply = vi.fn().mockResolvedValue(undefined);
    render(
      <FilePropertiesDialog
        entry={makeEntry({ permissions: 0o4755, permissionsDisplay: "rwxr-xr-x" })}
        capabilities={CAPS}
        onApplyPermissions={onApply}
        onClose={() => {}}
      />,
    );

    // The special-bit notice is shown...
    expect(screen.getByTestId("perm-special-bits")).toHaveTextContent("setuid");

    // ...and toggling a regular bit keeps setuid (0o4000) in the applied mode.
    fireEvent.click(screen.getByTestId("perm-groupW")); // 0o755 -> 0o775
    fireEvent.click(applyBtn());
    await vi.waitFor(() => expect(onApply).toHaveBeenCalled());
    expect(onApply).toHaveBeenCalledWith(expect.anything(), 0o4775, false);
  });

  it("does NOT propagate the root's special bits on a recursive apply", async () => {
    const onApply = vi.fn().mockResolvedValue({ applied: 1, errors: [] });
    render(
      <FilePropertiesDialog
        entry={makeEntry({
          entryType: "Directory",
          id: "/home/user/dir",
          name: "dir",
          permissions: 0o4755,
          permissionsDisplay: "rwxr-xr-x",
        })}
        capabilities={CAPS}
        onApplyPermissions={onApply}
        onClose={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("perm-recursive"));
    fireEvent.click(applyBtn());
    await vi.waitFor(() => expect(onApply).toHaveBeenCalled());
    // 0o755, not 0o4755 — recursive matches `chmod -R <octal>` semantics.
    expect(onApply).toHaveBeenCalledWith(expect.anything(), 0o755, true);
  });

  it("disables Apply until something changes, then enables it", () => {
    render(
      <FilePropertiesDialog entry={makeEntry()} capabilities={CAPS} onApplyPermissions={vi.fn()} onClose={() => {}} />,
    );
    expect(applyBtn()).toBeDisabled();
    fireEvent.click(screen.getByTestId("perm-otherW"));
    expect(applyBtn()).not.toBeDisabled();
  });

  it("enables Apply for a directory when recursive is checked, even if unchanged", () => {
    render(
      <FilePropertiesDialog
        entry={makeEntry({ entryType: "Directory", id: "/home/user/dir", name: "dir" })}
        capabilities={CAPS}
        onApplyPermissions={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect(applyBtn()).toBeDisabled();
    fireEvent.click(screen.getByTestId("perm-recursive"));
    expect(applyBtn()).not.toBeDisabled();
  });

  it("re-syncs the octal field when the entry's permissions change underneath", () => {
    const { rerender } = render(
      <FilePropertiesDialog
        entry={makeEntry({ permissions: 0o644, permissionsDisplay: "rw-r--r--" })}
        capabilities={CAPS}
        onApplyPermissions={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect(octalInput().value).toBe("644");

    rerender(
      <FilePropertiesDialog
        entry={makeEntry({ permissions: 0o600, permissionsDisplay: "rw-------" })}
        capabilities={CAPS}
        onApplyPermissions={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect(octalInput().value).toBe("600");
  });

  it("surfaces a failed apply as an accessible alert", async () => {
    const onApply = vi.fn().mockRejectedValue(new Error("kaboom"));
    render(
      <FilePropertiesDialog
        entry={makeEntry({ permissions: 0o644, permissionsDisplay: "rw-r--r--" })}
        capabilities={CAPS}
        onApplyPermissions={onApply}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("perm-ownerX"));
    fireEvent.click(applyBtn());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("kaboom");
  });

  it("does not show the special-bit notice for a plain file", () => {
    render(
      <FilePropertiesDialog
        entry={makeEntry({ permissions: 0o644, permissionsDisplay: "rw-r--r--" })}
        capabilities={CAPS}
        onApplyPermissions={vi.fn()}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId("perm-special-bits")).not.toBeInTheDocument();
  });

  it("changes the special-bit notice to 'dropped' when recursive is enabled", () => {
    render(
      <FilePropertiesDialog
        entry={makeEntry({
          entryType: "Directory",
          id: "/home/user/dir",
          name: "dir",
          permissions: 0o1755, // sticky
          permissionsDisplay: "rwxr-xr-x",
        })}
        capabilities={CAPS}
        onApplyPermissions={vi.fn()}
        onClose={() => {}}
      />,
    );
    // Single-file semantics by default: bits are preserved.
    expect(screen.getByTestId("perm-special-bits")).toHaveTextContent("preserved on apply");

    fireEvent.click(screen.getByTestId("perm-recursive"));
    // Recursive drops special bits across the tree — the notice must say so.
    expect(screen.getByTestId("perm-special-bits")).toHaveTextContent("dropped on a recursive apply");
  });

  it("does NOT clobber an in-progress edit when the parent re-renders with the same permissions", () => {
    const entryV1 = makeEntry({ permissions: 0o644, permissionsDisplay: "rw-r--r--" });
    const { rerender } = render(
      <FilePropertiesDialog entry={entryV1} capabilities={CAPS} onApplyPermissions={vi.fn()} onClose={() => {}} />,
    );
    // User edits the octal field mid-flight.
    fireEvent.change(octalInput(), { target: { value: "700" } });
    expect(octalInput().value).toBe("700");

    // Parent re-renders with a NEW entry object but the SAME permissions string.
    rerender(
      <FilePropertiesDialog
        entry={{ ...entryV1 }}
        capabilities={CAPS}
        onApplyPermissions={vi.fn()}
        onClose={() => {}}
      />,
    );
    // initialOctal is unchanged (same number), so the resync effect must NOT fire.
    expect(octalInput().value).toBe("700");
  });

  it("rolls the mode back and disables Apply when the octal field is cleared", () => {
    render(
      <FilePropertiesDialog
        entry={makeEntry({ permissions: 0o644, permissionsDisplay: "rw-r--r--" })}
        capabilities={CAPS}
        onApplyPermissions={vi.fn()}
        onClose={() => {}}
      />,
    );
    // Make a dirty edit, then clear the field entirely.
    fireEvent.change(octalInput(), { target: { value: "755" } });
    expect(applyBtn()).not.toBeDisabled();

    fireEvent.change(octalInput(), { target: { value: "" } });
    // octal rolled back to initial (0o644) → not dirty → Apply disabled, so a
    // click can't submit a stale invisible value.
    expect(applyBtn()).toBeDisabled();
  });
});
