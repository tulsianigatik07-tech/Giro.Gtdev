import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import LoginPage from "@/app/login/page";

vi.mock("@/features/auth/auth-context", () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/features/auth/login-form", () => ({ LoginForm: () => <form aria-label="Access token sign in"><label htmlFor="token">Giro access token</label><input id="token" /></form> }));

describe("login composition", () => {
  it("renders one focused engineering-workspace entry panel without promotional feature cards", () => {
    render(<LoginPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Welcome to Giro" })).toBeInTheDocument();
    expect(screen.getByRole("form", { name: "Access token sign in" })).toBeInTheDocument();
    expect(screen.getByText("Engineering workspace")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to overview" })).toHaveAttribute("href", "/");
    expect(screen.queryByText("Repository aware")).not.toBeInTheDocument();
  });
});
