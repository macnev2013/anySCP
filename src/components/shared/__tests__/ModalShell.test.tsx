import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModalShell } from "../ModalShell";

function renderShell(banner?: React.ReactNode) {
  return render(
    <ModalShell open onClose={() => {}} title="Edit Host" scrollable testId="shell" banner={banner}>
      <div data-testid="long-form" style={{ height: 5000 }}>form</div>
    </ModalShell>,
  );
}

describe("ModalShell banner", () => {
  it("renders the banner outside the scrolling body so it stays visible", () => {
    renderShell(<p role="alert">Authentication failed: server rejected credentials</p>);

    const banner = screen.getByRole("alert");
    const body = screen.getByTestId("long-form").parentElement!;
    expect(body).toHaveClass("overflow-y-auto");
    expect(body).not.toContainElement(banner);
    expect(screen.getByTestId("shell")).toContainElement(banner);
  });

  it("places the banner between the header and the body", () => {
    renderShell(<p role="alert">error</p>);

    const panel = screen.getByTestId("shell");
    const sections = Array.from(panel.children);
    const bannerIdx = sections.findIndex((el) => el.contains(screen.getByRole("alert")));
    const headerIdx = sections.findIndex((el) => el.contains(screen.getByRole("heading")));
    const bodyIdx = sections.findIndex((el) => el.contains(screen.getByTestId("long-form")));
    expect(headerIdx).toBeLessThan(bannerIdx);
    expect(bannerIdx).toBeLessThan(bodyIdx);
  });

  it("renders no banner area when there is nothing to show", () => {
    renderShell();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByTestId("shell").children).toHaveLength(2); // header + body
  });
});
