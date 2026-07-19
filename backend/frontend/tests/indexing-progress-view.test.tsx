import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IndexingProgressView } from "@/features/indexing/indexing-progress-view";

const push = vi.fn();
const indexing = vi.hoisted(() => ({
  stage: "failed" as "queued" | "cloning" | "parsing" | "chunking" | "embedding" | "uploading_vectors" | "finalizing" | "completed" | "failed",
  percentage: 32,
  message: "Clone failed",
  connected: false,
  disconnected: true,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("@/hooks/use-indexing-progress", () => ({
  useIndexingProgress: () => ({
    progress: { jobId: "job-1", repositoryId: "acme/platform", stage: indexing.stage, percentage: indexing.percentage, message: indexing.message, timestamp: "2026-07-18T00:00:00Z" },
    connected: indexing.connected,
    disconnected: indexing.disconnected,
    reconnecting: false,
    streamError: null,
    retry: vi.fn(),
  }),
}));

describe("indexing progress presentation", () => {
  beforeEach(() => {
    push.mockReset();
    indexing.stage = "failed";
    indexing.percentage = 32;
    indexing.message = "Clone failed";
    indexing.connected = false;
    indexing.disconnected = true;
  });

  it("announces failure and marks the supported active timeline stage failed", () => {
    render(<IndexingProgressView owner="acme" repo="platform" jobId="job-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing Failed, 32 percent. Clone failed");
    expect(screen.getByText("Disconnected")).toBeInTheDocument();
    expect(within(screen.getByText("Queue indexing job").closest("li") as HTMLElement).getByText("Failed")).toBeInTheDocument();
  });

  it("presents backend stage and percentage without inventing completion", () => {
    indexing.stage = "parsing";
    indexing.percentage = 28;
    indexing.message = "Parsing repository";
    indexing.connected = true;
    indexing.disconnected = false;
    render(<IndexingProgressView owner="acme" repo="platform" jobId="job-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Indexing Read repository structure, 28 percent. Parsing repository");
    expect(within(screen.getByText("Read repository structure").closest("li") as HTMLElement).getByText("In progress")).toBeInTheDocument();
    expect(within(screen.getByText("Build searchable chunks").closest("li") as HTMLElement).getByText("Pending")).toBeInTheDocument();
  });

  it("announces repository readiness and presents real next destinations", () => {
    indexing.stage = "completed";
    indexing.percentage = 100;
    indexing.message = "Done";
    indexing.connected = true;
    indexing.disconnected = false;
    render(<IndexingProgressView owner="acme" repo="platform" jobId="job-1" />);
    expect(screen.getByRole("status")).toHaveTextContent("Repository ready. acme/platform indexing completed.");
    expect(screen.getByRole("heading", { level: 1, name: "Repository ready" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Repository overview/ })).toHaveAttribute("href", "/repositories/acme/platform");
    expect(screen.getByRole("link", { name: /Search repository/ })).toHaveAttribute("href", "/repositories/acme/platform/search");
    expect(screen.getByRole("link", { name: /Ask Giro/ })).toHaveAttribute("href", "/repositories/acme/platform");
    expect(screen.getByRole("link", { name: /Start a session/ })).toHaveAttribute("href", "/repositories/acme/platform");
  });
});
