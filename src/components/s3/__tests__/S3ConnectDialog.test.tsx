import { describe, it, expect, beforeEach, vi } from "vitest";
import { StrictMode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { S3ConnectDialog } from "../S3ConnectDialog";
import { useGroupsStore } from "../../../stores/groups-store";
import type { S3Connection } from "../../../types";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

const SAVED_MINIO: S3Connection = {
  id: "conn-1",
  label: "Corp MinIO",
  provider: "minio",
  region: "eu-west-1",
  endpoint: "https://minio.mycorp.internal:9443",
  bucket: "backups",
  path_style: true,
  group_id: null,
  color: null,
  environment: null,
  notes: null,
  created_at: "2026-01-01T00:00:00Z",
};

const endpointInput = () =>
  screen.getByTestId("s3-dialog-endpoint") as HTMLInputElement;

describe("S3ConnectDialog — provider presets vs saved values", () => {
  beforeEach(() => {
    invoke.mockReset();
    // The dialog loads groups on mount; anything but an array would be
    // written into the groups store and break later renders.
    invoke.mockImplementation(async (cmd: string) => (cmd === "list_groups" ? [] : undefined));
    useGroupsStore.setState({ groups: [] });
    // jsdom doesn't implement it; CustomSelect scrolls the highlighted option.
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("keeps the saved endpoint and region when opened in edit mode", () => {
    // StrictMode on purpose: the original bug only appeared under StrictMode's
    // double effect run, which defeated the "skip the first run" guard and
    // reset a saved MinIO endpoint to the provider default (localhost:9000).
    render(
      <StrictMode>
        <S3ConnectDialog onClose={() => {}} editConnection={SAVED_MINIO} />
      </StrictMode>,
    );

    expect(endpointInput().value).toBe("https://minio.mycorp.internal:9443");
    expect((screen.getByTestId("s3-dialog-region") as HTMLInputElement).value).toBe("eu-west-1");
  });

  it("applies the preset only when the user actively changes the provider", () => {
    render(
      <StrictMode>
        <S3ConnectDialog onClose={() => {}} editConnection={SAVED_MINIO} />
      </StrictMode>,
    );

    fireEvent.click(screen.getByTestId("s3-dialog-provider"));
    fireEvent.click(screen.getByRole("option", { name: "LocalStack" }));

    expect(endpointInput().value).toBe("http://localhost:4566");
  });

  it("starts a new connection on AWS defaults and presets on provider choice", () => {
    render(
      <StrictMode>
        <S3ConnectDialog onClose={() => {}} />
      </StrictMode>,
    );

    // AWS default: region seeded, no endpoint field (AWS needs none).
    expect((screen.getByTestId("s3-dialog-region") as HTMLInputElement).value).toBe("us-east-1");
    expect(screen.queryByTestId("s3-dialog-endpoint")).toBeNull();

    fireEvent.click(screen.getByTestId("s3-dialog-provider"));
    fireEvent.click(screen.getByRole("option", { name: "MinIO" }));

    expect(endpointInput().value).toBe("http://localhost:9000");
  });
});
