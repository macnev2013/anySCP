import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DropOverwriteDialog } from "./DropOverwriteDialog";

function renderDialog(over: Partial<React.ComponentProps<typeof DropOverwriteDialog>> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <DropOverwriteDialog
      conflicts={over.conflicts ?? ["a.txt"]}
      targetDir={over.targetDir ?? "/home/user"}
      onConfirm={over.onConfirm ?? onConfirm}
      onCancel={over.onCancel ?? onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe("DropOverwriteDialog", () => {
  it("shows singular copy and the conflicting name for one conflict", () => {
    renderDialog({ conflicts: ["report.pdf"] });
    expect(screen.getByText("Overwrite item?")).toBeInTheDocument();
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
  });

  it("shows plural copy and lists every conflict for many", () => {
    renderDialog({ conflicts: ["a.txt", "b.txt", "c.txt"] });
    expect(screen.getByText("Overwrite 3 items?")).toBeInTheDocument();
    for (const n of ["a.txt", "b.txt", "c.txt"]) {
      expect(screen.getByText(n)).toBeInTheDocument();
    }
  });

  it("explains that folders are merged rather than replaced", () => {
    renderDialog();
    expect(
      screen.getByText(/folders are merged, replacing only same-named files/i),
    ).toBeInTheDocument();
  });

  it("fires onConfirm only when Overwrite is clicked", () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByTestId("explorer-overwrite-confirm-button"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("fires onCancel on Cancel, backdrop click, and Escape", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <DropOverwriteDialog conflicts={["a.txt"]} targetDir="/x" onConfirm={vi.fn()} onCancel={onCancel} />,
    );

    fireEvent.click(screen.getByTestId("explorer-overwrite-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);

    // The backdrop is the panel's parent. It closes only when the press both
    // starts AND ends on the backdrop itself (testId is on the panel).
    const panel = screen.getByTestId("explorer-overwrite-confirm");
    const backdrop = panel.parentElement as HTMLElement;

    // A drag that starts on the panel and releases on the backdrop — e.g.
    // selecting text in a field — must NOT close and discard input.
    fireEvent.mouseDown(panel);
    fireEvent.mouseUp(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(1);

    // A genuine press that starts and ends on the backdrop closes it.
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    expect(onCancel).toHaveBeenCalledTimes(2);

    // ModalShell's Escape listener is on document; an event fired on window
    // wouldn't reach it.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(3);

    // Keep rerender referenced (the dialog mounts a document keydown listener).
    rerender(
      <DropOverwriteDialog conflicts={["a.txt"]} targetDir="/x" onConfirm={vi.fn()} onCancel={onCancel} />,
    );
  });

  it("exposes dialog semantics and focuses Cancel on open", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("explorer-overwrite-cancel")).toHaveFocus();
  });
});
