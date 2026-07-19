import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_PRODUCTS, PlatformNavigation } from "@/components/platform/platform-navigation";

describe("platform navigation", () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    };
  });

  it("marks Web active and navigates to the workspace entry", () => {
    render(<PlatformNavigation />);
    expect(screen.getByRole("navigation", { name: "Giro products" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Web ACTIVE/i })).toHaveAttribute("href", "/dashboard");
    expect(screen.getByRole("link", { name: /Web ACTIVE/i })).toHaveAttribute("aria-current", "page");
  });

  it.each([
    ["CLI", "Repository intelligence directly from the terminal."],
    ["IDE", "Grounded repository understanding inside your editor."],
    ["Mobile", "Review sessions and repository evidence on the move."],
    ["Enterprise", "Organization controls, private deployments, and team workflows."],
  ])("opens Coming Soon for %s without navigating", async (name, description) => {
    const user = userEvent.setup();
    render(<PlatformNavigation />);
    const product = screen.getByRole("button", { name: `${name}, coming soon` });
    await user.click(product);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name })).toBeInTheDocument();
    expect(within(dialog).getByText(description)).toBeInTheDocument();
    expect(within(dialog).getByText("Coming soon")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: new RegExp(name, "i") })).not.toBeInTheDocument();
  });

  it("supports keyboard activation, Escape, and focus restoration", async () => {
    const user = userEvent.setup();
    render(<PlatformNavigation />);
    const cli = screen.getByRole("button", { name: "CLI, coming soon" });
    cli.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(cli).toHaveFocus());
  });

  it("uses the same product configuration in public and authenticated variants", async () => {
    const user = userEvent.setup();
    const view = render(<PlatformNavigation />);
    const publicNavigation = screen.getByRole("navigation", { name: "Giro products" });
    for (const product of PLATFORM_PRODUCTS) expect(within(publicNavigation).getByText(product.name)).toBeInTheDocument();

    view.unmount();
    render(<PlatformNavigation variant="compact" />);
    await user.click(screen.getByRole("button", { name: "Switch Giro product. Web is active." }));
    const menu = screen.getByRole("menu", { name: "Giro products" });
    for (const product of PLATFORM_PRODUCTS) expect(within(menu).getByText(product.name)).toBeInTheDocument();
  });

  it("closes the compact product menu with Escape and restores its trigger", async () => {
    const user = userEvent.setup();
    render(<PlatformNavigation variant="compact" />);
    const trigger = screen.getByRole("button", { name: "Switch Giro product. Web is active." });
    await user.click(trigger);
    expect(screen.getByRole("menu", { name: "Giro products" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Giro products" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
