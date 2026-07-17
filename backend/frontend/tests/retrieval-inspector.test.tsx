import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RetrievalInspector } from "@/features/retrieval/retrieval-inspector";

describe("retrieval inspector public contract", () => {
  it("shows exposed ranking metadata and marks unavailable stitching/expansion fields", () => {
    render(<RetrievalInspector loading={false} error={null} retrieval={{
      query: "auth",
      repository: "acme/platform",
      results: [{ repository: "acme/platform", filePath: "src/auth.ts", language: "typescript", content: "private source", startLine: 1, endLine: 4, score: 0.8, source: "semantic", signals: { semantic: 0.8 } }],
      stats: { semanticResults: 1, keywordResults: 0, symbolResults: 0, graphBoosted: 0, returned: 1 },
    }} />);
    expect(screen.getByText("stitched: not exposed")).toBeInTheDocument();
    expect(screen.getByText("expanded: not exposed")).toBeInTheDocument();
    expect(screen.queryByText("private source")).not.toBeInTheDocument();
    expect(screen.queryByText(/cache-hit|rank trace|graph-expanded/i)).not.toBeInTheDocument();
  });
});
