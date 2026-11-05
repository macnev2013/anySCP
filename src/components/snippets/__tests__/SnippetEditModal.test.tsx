import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SnippetEditModal } from "../SnippetEditModal";
import type { Snippet, SnippetFolder } from "../../../types";

// Issue #150: create a folder straight from the New Snippet folder picker.

const FOLDER: SnippetFolder = {
  id: "f-ops",
  name: "Ops",
  parent_id: null,
  color: null,
  icon: null,
  sort_order: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

function renderModal(props: Partial<Parameters<typeof SnippetEditModal>[0]> = {}) {
  const onSave = vi.fn<(s: Snippet) => Promise<void>>(async () => {});
  const onClose = vi.fn();
  const utils = render(
    <SnippetEditModal
      open
      initial={null}
      folders={[FOLDER]}
      onClose={onClose}
      onSave={onSave}
      onSaveAndExecute={async () => {}}
      {...props}
    />,
  );
  return { ...utils, onSave, onClose };
}

const picker = () => screen.getByTestId("snippet-modal-folder");
const newFolderInput = () =>
  screen.getByTestId("snippet-modal-new-folder-name") as HTMLInputElement;

function chooseNewFolder() {
  fireEvent.click(picker());
  fireEvent.click(screen.getByTestId("snippet-modal-folder-option-__new_folder__"));
}

async function fillAndSave() {
  fireEvent.change(screen.getByTestId("snippet-modal-name"), { target: { value: "Restart" } });
  fireEvent.change(screen.getByTestId("snippet-modal-command"), {
    target: { value: "systemctl restart nginx" },
  });
  fireEvent.click(screen.getByTestId("snippet-modal-save"));
}

describe("SnippetEditModal — new folder from the folder picker (#150)", () => {
  beforeEach(() => {
    // jsdom doesn't implement it; CustomSelect scrolls the highlighted option.
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("offers no New folder entry without onCreateFolder", () => {
    renderModal();
    fireEvent.click(picker());
    expect(screen.queryByTestId("snippet-modal-folder-option-__new_folder__")).toBeNull();
  });

  it("creates the folder on Enter, selects it, and saves the snippet into it", async () => {
    const onCreateFolder = vi.fn(async () => "f-new");
    const { onSave, rerender } = renderModal({ onCreateFolder });

    chooseNewFolder();
    fireEvent.change(newFolderInput(), { target: { value: "  Deploys  " } });
    fireEvent.keyDown(newFolderInput(), { key: "Enter" });

    await waitFor(() => expect(onCreateFolder).toHaveBeenCalledWith("Deploys"));
    // The page reloads folders after saving; mirror that so the picker can label it.
    rerender(
      <SnippetEditModal
        open
        initial={null}
        folders={[FOLDER, { ...FOLDER, id: "f-new", name: "Deploys" }]}
        onClose={() => {}}
        onSave={onSave}
        onSaveAndExecute={async () => {}}
        onCreateFolder={onCreateFolder}
      />,
    );
    await waitFor(() => expect(picker().getAttribute("data-value")).toBe("f-new"));
    expect(picker().textContent).toContain("Deploys");

    await fillAndSave();
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0][0].folder_id).toBe("f-new");
  });

  it("selects an existing folder with the same name instead of creating a twin", async () => {
    const onCreateFolder = vi.fn(async () => "f-dup");
    renderModal({ onCreateFolder });

    chooseNewFolder();
    fireEvent.change(newFolderInput(), { target: { value: "ops" } });
    fireEvent.click(screen.getByTestId("snippet-modal-new-folder-add"));

    await waitFor(() => expect(picker().getAttribute("data-value")).toBe("f-ops"));
    expect(onCreateFolder).not.toHaveBeenCalled();
  });

  it("Escape cancels the new folder but keeps the snippet dialog open", () => {
    const onCreateFolder = vi.fn(async () => "f-new");
    const { onClose } = renderModal({ onCreateFolder });

    chooseNewFolder();
    fireEvent.keyDown(newFolderInput(), { key: "Escape" });

    expect(screen.queryByTestId("snippet-modal-new-folder-name")).toBeNull();
    expect(picker().getAttribute("data-value")).toBe("");
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreateFolder).not.toHaveBeenCalled();
  });

  it("shows the error and keeps the input when creating fails", async () => {
    const onCreateFolder = vi.fn(async () => {
      throw { message: "disk full" };
    });
    renderModal({ onCreateFolder });

    chooseNewFolder();
    fireEvent.change(newFolderInput(), { target: { value: "Deploys" } });
    fireEvent.keyDown(newFolderInput(), { key: "Enter" });

    expect(await screen.findByText("disk full")).toBeTruthy();
    expect(newFolderInput().value).toBe("Deploys");
  });
});
