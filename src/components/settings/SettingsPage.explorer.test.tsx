import "@testing-library/jest-dom/vitest";
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsPage } from "./SettingsPage";
import { useSettingsStore } from "../../stores/settings-store";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it("offers a persisted global Show/Hide default and explains the session-only toolbar", async () => {
  const canvas = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  useSettingsStore.setState({ explorerShowHiddenFiles: true, loaded: true });
  render(<SettingsPage />);
  fireEvent.click(screen.getByTestId("settings-nav-explorer"));
  expect(screen.getByText("Hidden Files by Default")).toBeInTheDocument();
  expect(screen.getByText(/toolbar changes only the current session/)).toBeInTheDocument();
  expect(screen.getByRole("radio", { name: "Show" })).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("radio", { name: "Hide" }));
  expect(screen.getByRole("radio", { name: "Hide" })).toHaveAttribute("aria-checked", "true");
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("save_setting", { key: "explorer_show_hidden_files", value: "false" }));
  canvas.mockRestore();
});
