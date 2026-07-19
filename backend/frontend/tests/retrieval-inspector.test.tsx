import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RetrievalInspector } from "@/features/retrieval/retrieval-inspector";

describe("retrieval inspector public contract", () => {
  it("shows exposed ranking metadata and marks unavailable stitching/expansion fields", () => {
    render(<RetrievalInspector loading={false} error={null} retrieval={{
      query: "auth",
      repository: "acme/platform",
      results: [{ repository: "acme/platform", filePath: "src/auth.ts", language: "typescript", content: "private source", startLine: 1, endLine: 4, score: 0.8, source: "semantic", signals: { semantic: 0.8 }, symbol: "authenticate" }],
      stats: { semanticResults: 1, keywordResults: 0, symbolResults: 0, graphBoosted: 0, returned: 1 },
    }} />);
    expect(screen.getByText("Stitching")).toBeInTheDocument();
    expect(screen.getByText("Expansion")).toBeInTheDocument();
    expect(screen.getAllByText("Not exposed")).toHaveLength(3);
    expect(screen.getByText("private source")).toBeInTheDocument();
    expect(screen.getByText("SYMBOL authenticate")).toBeInTheDocument();
    expect(screen.getByLabelText("Evidence excerpt from src/auth.ts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy path src/auth.ts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Source link unavailable" })).toBeDisabled();
    expect(screen.queryByText(/cache-hit|rank trace|graph-expanded/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Collapse/ }));
    expect(screen.queryByLabelText("Evidence excerpt from src/auth.ts")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Expand/ }));
    expect(screen.getByLabelText("Evidence excerpt from src/auth.ts")).toBeInTheDocument();
  });

  it("announces evidence loading", () => {
    render(<RetrievalInspector loading error={null} retrieval={null} />);
    expect(screen.getByRole("status", { name: "Loading retrieval evidence" })).toHaveTextContent("Loading retrieval evidence.");
  });
});
