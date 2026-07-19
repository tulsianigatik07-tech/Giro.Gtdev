import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardCommandCenter } from "@/features/repositories/dashboard-command-center";
import { repository } from "./fixtures";
import type { IndexedRepository, SessionSummary } from "@/types/api";

const repositories: IndexedRepository[] = [
  { ...repository, owner: "acme", repo: "platform", status: "indexed", lastAccessedAt: "2026-07-19T09:00:00.000Z" },
  { ...repository, owner: "acme", repo: "worker", status: "indexing", indexedAt: null, lastAccessedAt: null },
  { ...repository, owner: "acme", repo: "legacy", status: "stale", lastAccessedAt: "2026-07-18T09:00:00.000Z" },
  { ...repository, owner: "acme", repo: "broken", status: "failed", indexedAt: null, lastAccessedAt: null },
];

const recentSession: SessionSummary = {
  id: "session-1",
  userId: "user-1",
  owner: "acme",
  repo: "platform",
  title: "Trace authentication",
  createdAt: "2026-07-19T08:00:00.000Z",
  updatedAt: "2026-07-19T10:00:00.000Z",
  messageCount: 6,
};

describe("dashboard command center", () => {
  it("presents command-center sections in the intended reading order", () => {
    render(<DashboardCommandCenter repositories={repositories} sessions={[recentSession]} />);
    const commandCenter = screen.getByLabelText("Engineering command center");
    const headings = within(commandCenter).getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual([
      "Continue investigation",
      "Repository status",
      "Investigation timeline",
      "Repository actions",
    ]);
  });

  it("features the newest recorded session without generating a summary", () => {
    render(<DashboardCommandCenter repositories={repositories} sessions={[recentSession]} />);
    const section = screen.getByRole("region", { name: "Continue investigation" });
    expect(within(section).getByRole("heading", { name: "Trace authentication" })).toBeInTheDocument();
    expect(within(section).getByText("acme/platform")).toBeInTheDocument();
    expect(within(section).getByRole("time")).toHaveAttribute("datetime", recentSession.updatedAt);
    expect(within(section).getByRole("link", { name: "Continue session" })).toHaveAttribute("href", "/chat/session-1");
  });

  it("groups repositories by existing backend status while preserving group order", () => {
    render(<DashboardCommandCenter repositories={repositories} sessions={[recentSession]} />);
    const ready = screen.getByRole("region", { name: "Ready repositories" });
    const indexing = screen.getByRole("region", { name: "Indexing repositories" });
    const attention = screen.getByRole("region", { name: "Needs attention repositories" });
    expect(within(ready).getByRole("heading", { name: "platform" })).toBeInTheDocument();
    expect(within(indexing).getByRole("heading", { name: "worker" })).toBeInTheDocument();
    expect(within(attention).getByRole("heading", { name: "legacy" })).toBeInTheDocument();
    expect(within(attention).getByRole("heading", { name: "broken" })).toBeInTheDocument();
  });

  it("shows only real actions for the selected ready repository", () => {
    render(<DashboardCommandCenter repositories={repositories} sessions={[recentSession]} />);
    const actions = screen.getByRole("navigation", { name: "Repository actions" });
    expect(within(actions).getByRole("link", { name: /Open overview/ })).toHaveAttribute("href", "/repositories/acme/platform");
    expect(within(actions).getByRole("link", { name: /Search repository/ })).toHaveAttribute("href", "/repositories/acme/platform/search");
    expect(within(actions).getByRole("link", { name: /Continue session/ })).toHaveAttribute("href", "/chat/session-1");
    expect(within(actions).getByRole("link", { name: /Connect repository/ })).toHaveAttribute("href", "/repositories/connect");
    expect(within(actions).queryByRole("link", { name: /View indexing/ })).not.toBeInTheDocument();
  });

  it("uses the existing indexing route when the resumable repository is indexing", () => {
    render(<DashboardCommandCenter repositories={[repositories[1]]} sessions={[]} />);
    const actions = screen.getByRole("navigation", { name: "Repository actions" });
    expect(within(actions).getByRole("link", { name: /View indexing/ })).toHaveAttribute("href", "/repositories/acme/worker/indexing");
    expect(within(actions).queryByRole("link", { name: /Search repository/ })).not.toBeInTheDocument();
  });

  it("renders dashboard-shaped loading regions with live semantics", () => {
    render(<DashboardCommandCenter repositoriesLoading sessionsLoading />);
    expect(screen.getByRole("status", { name: "Loading continue investigation" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading repository command center" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading investigation timeline" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading repository actions" })).toBeInTheDocument();
  });

  it("keeps semantic landmarks and responsive grid composition", () => {
    render(<DashboardCommandCenter repositories={repositories} sessions={[recentSession]} />);
    expect(screen.getByRole("region", { name: "Repository status" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Investigation timeline" })).toBeInTheDocument();
    expect(screen.getByTestId("repository-status-layout").className).toContain("laptop:grid-cols-[repeat(auto-fit,minmax(260px,1fr))]");
    expect(screen.getByTestId("repository-actions-layout").className).toContain("mobile:grid-cols-2");
    expect(screen.getByTestId("repository-actions-layout").className).toContain("laptop:grid-cols-4");
  });
});
