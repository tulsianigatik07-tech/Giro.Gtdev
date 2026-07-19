import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SessionTimeline } from "@/features/sessions/session-timeline";
import type { SessionSummary } from "@/types/api";

const now = new Date("2026-07-19T12:00:00.000Z");

function makeSession(input: Partial<SessionSummary> & Pick<SessionSummary, "id" | "title" | "updatedAt">): SessionSummary {
  return {
    userId: "user-1",
    owner: "acme",
    repo: "platform",
    createdAt: input.updatedAt,
    messageCount: 2,
    ...input,
  };
}

const sessions = [
  makeSession({ id: "earlier", title: "Trace worker startup", updatedAt: "2026-07-15T09:00:00.000Z", createdAt: "2026-07-14T08:00:00.000Z" }),
  makeSession({ id: "today", title: "Investigate authentication", updatedAt: "2026-07-19T10:00:00.000Z", createdAt: "2026-07-19T08:00:00.000Z", messageCount: 8 }),
  makeSession({ id: "yesterday", title: "Review API routes", updatedAt: "2026-07-18T11:00:00.000Z", createdAt: "2026-07-18T09:00:00.000Z", messageCount: 4 }),
];

describe("session timeline", () => {
  it("groups recorded timestamps and orders sessions by last activity", () => {
    render(<SessionTimeline sessions={sessions} startHref="/repositories/acme/platform" now={now} />);
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Yesterday" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Earlier" })).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => within(link).getByRole("heading", { level: 4 }).textContent)).toEqual([
      "Investigate authentication",
      "Review API routes",
      "Trace worker startup",
    ]);
  });

  it("marks only the latest session as Continue investigation", () => {
    render(<SessionTimeline sessions={sessions} startHref="/repositories/acme/platform" now={now} />);
    const current = screen.getByRole("link", { name: /Investigate authentication/ });
    expect(current).toHaveAttribute("href", "/chat/today");
    expect(within(current).getByText("Continue investigation")).toBeInTheDocument();
    expect(screen.getAllByText("Continue investigation")).toHaveLength(1);
  });

  it("uses the session title as its preview and exposes recorded timestamps", () => {
    render(<SessionTimeline sessions={[sessions[0]]} startHref="/repositories/acme/platform" now={now} />);
    expect(screen.getByLabelText("Session preview: Trace worker startup")).toHaveTextContent("Resume “Trace worker startup”.");
    const times = screen.getAllByRole("time");
    expect(times[0]).toHaveAttribute("datetime", "2026-07-15T09:00:00.000Z");
    expect(times[1]).toHaveAttribute("datetime", "2026-07-14T08:00:00.000Z");
    expect(screen.getByText("2 messages")).toBeInTheDocument();
  });

  it("offers a real repository route when no sessions exist", () => {
    render(<SessionTimeline sessions={[]} startHref="/repositories/acme/platform" now={now} />);
    expect(screen.getByRole("heading", { name: "No investigations recorded." })).toBeInTheDocument();
    expect(screen.getByText(/conversations appear here after a session is started/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start your first investigation" })).toHaveAttribute("href", "/repositories/acme/platform");
  });

  it("uses semantic lists, keyboard-focusable links, and responsive composition", () => {
    render(<SessionTimeline sessions={sessions} startHref="/repositories/acme/platform" now={now} />);
    expect(screen.getByRole("list", { name: "Today sessions" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Yesterday sessions" })).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Earlier sessions" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Investigate authentication/ });
    link.focus();
    expect(link).toHaveFocus();
    expect(link.className).toContain("mobile:grid-cols");
    expect(screen.getByTestId("session-timeline-layout").className).toContain("laptop:grid-cols");
  });

  it("announces loading and derives recent activity only from session creation", () => {
    const view = render(<SessionTimeline loading startHref="/repositories/acme/platform" now={now} />);
    expect(screen.getByRole("status", { name: "Loading investigation timeline" })).toHaveTextContent("Loading investigation timeline.");
    view.rerender(<SessionTimeline sessions={sessions} startHref="/repositories/acme/platform" now={now} />);
    const activity = screen.getByRole("heading", { name: "Recent activity" }).closest("aside");
    expect(activity).not.toBeNull();
    expect(within(activity as HTMLElement).getAllByText("Session created")).toHaveLength(3);
    expect(within(activity as HTMLElement).queryByText(/indexed|connected/i)).not.toBeInTheDocument();
  });
});
