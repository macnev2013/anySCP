import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExplorerToolbar } from "../ExplorerToolbar";
import { createSftpProvider } from "../../../providers/sftp-provider";
import { createS3Provider } from "../../../providers/s3-provider";
import type { FileSystemProvider } from "../../../types/explorer";

function renderToolbar(over: {
  provider?: FileSystemProvider;
  currentPath?: string;
  segments?: { label: string; path: string }[];
  onNavigate?: (p: string) => void;
  loading?: boolean;
} = {}) {
  const onNavigate = over.onNavigate ?? vi.fn();
  render(
    <ExplorerToolbar
      provider={over.provider ?? createSftpProvider("sess-1")}
      currentPath={over.currentPath ?? "/var/log"}
      segments={
        over.segments ?? [
          { label: "/", path: "/" },
          { label: "var", path: "/var" },
          { label: "log", path: "/var/log" },
        ]
      }
      loading={over.loading ?? false}
      onRefresh={vi.fn()}
      onNewFolder={vi.fn()}
      onNewFile={vi.fn()}
      onNavigate={onNavigate}
      onUpload={vi.fn()}
    />,
  );
  return { onNavigate };
}

const pathBar = () => screen.getByLabelText("Current path");
const pathInput = () => screen.getByTestId("explorer-path-input") as HTMLInputElement;

function commitPath(value: string) {
  const input = pathInput();
  fireEvent.change(input, { target: { value } });
  // Enter blurs the input programmatically, and the blur commits — the input
  // unmounts immediately, so don't re-query it afterwards
  fireEvent.keyDown(input, { key: "Enter" });
  if (screen.queryByTestId("explorer-path-input")) fireEvent.blur(input);
}

describe("ExplorerToolbar — editable path bar", () => {
  it("opens an input pre-filled with the current path on click", () => {
    renderToolbar();
    fireEvent.click(pathBar());
    expect(pathInput().value).toBe("/var/log");
  });

  it("is keyboard-accessible: Enter on the focused bar begins editing", () => {
    renderToolbar();
    fireEvent.keyDown(pathBar(), { key: "Enter" });
    expect(pathInput()).toBeInTheDocument();
  });

  it("commits a typed path on Enter and navigates", () => {
    const { onNavigate } = renderToolbar();
    fireEvent.click(pathBar());
    commitPath("/etc/nginx");
    expect(onNavigate).toHaveBeenCalledWith("/etc/nginx");
    // The breadcrumb is back
    expect(screen.queryByTestId("explorer-path-input")).toBeNull();
  });

  it("normalizes SFTP paths: leading slash added, trailing stripped", () => {
    const { onNavigate } = renderToolbar();
    fireEvent.click(pathBar());
    commitPath("etc/nginx/");
    expect(onNavigate).toHaveBeenCalledWith("/etc/nginx");
  });

  it("normalizes S3 prefixes: leading slash stripped, trailing added", () => {
    const { onNavigate } = renderToolbar({
      provider: createS3Provider("sess-1", "my-bucket"),
      currentPath: "photos/",
      segments: [
        { label: "my-bucket", path: "" },
        { label: "photos", path: "photos/" },
      ],
    });
    fireEvent.click(pathBar());
    // Listing uses the "/" delimiter — without the trailing slash the prefix
    // would show the folder itself instead of its contents
    commitPath("/photos/2024");
    expect(onNavigate).toHaveBeenCalledWith("photos/2024/");
  });

  it("cancels on Escape without navigating", () => {
    const { onNavigate } = renderToolbar();
    fireEvent.click(pathBar());
    fireEvent.change(pathInput(), { target: { value: "/somewhere/else" } });
    fireEvent.keyDown(pathInput(), { key: "Escape" });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("explorer-path-input")).toBeNull();
  });

  it("does not navigate when the committed path is unchanged", () => {
    const { onNavigate } = renderToolbar();
    fireEvent.click(pathBar());
    commitPath("/var/log");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("segment clicks navigate directly without entering edit mode", () => {
    const { onNavigate } = renderToolbar();
    fireEvent.click(screen.getByTitle("Navigate to /var"));
    expect(onNavigate).toHaveBeenCalledWith("/var");
    expect(screen.queryByTestId("explorer-path-input")).toBeNull();
  });

  it("does not enter edit mode while loading", () => {
    renderToolbar({ loading: true });
    fireEvent.click(pathBar());
    expect(screen.queryByTestId("explorer-path-input")).toBeNull();
  });
});
