import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardScreen } from "@/features/repositories/dashboard-screen";

const state = vi.hoisted(() => ({ loading: false }));

vi.mock("@/hooks/use-repositories", () => ({
  useRepositories: () => ({
    data: state.loading ? undefined : { repositories: [], count: 0 },
    isLoading: state.loading,
    isError: false,
  }),
}));
vi.mock("@/hooks/use-sessions", () => ({ useSessions: () => ({ data: { sessions: [] }, isLoading: false, isError: false }) }));

describe("empty dashboard onboarding", () => {
  beforeEach(() => { state.loading = false; });

  it("presents the repository workflow in order with one primary connection action", () => {
    render(<DashboardScreen />);
    expect(screen.getByRole("heading", { name: "Establish repository context first." })).toBeInTheDocument();
    const steps = within(screen.getByRole("list", { name: "Repository onboarding steps" })).getAllByRole("listitem");
    expect(steps.map((step) => within(step).getByRole("heading").textContent)).toEqual([
      "Connect a repository",
      "Giro indexes repository knowledge",
      "Explore architecture",
      "Search repository evidence",
      "Ask repository-scoped questions",
    ]);
    expect(screen.getByRole("link", { name: "Connect repository" })).toHaveAttribute("href", "/repositories/connect");
    expect(screen.queryByRole("heading", { name: "Recent sessions" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Engineering command center")).not.toBeInTheDocument();
  });

  it("announces the repository-shaped loading state", () => {
    state.loading = true;
    render(<DashboardScreen />);
    expect(screen.getByRole("status", { name: "Loading repository command center" })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Repository onboarding steps" })).not.toBeInTheDocument();
  });
});
