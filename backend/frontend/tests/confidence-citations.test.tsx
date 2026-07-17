import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CitationList } from "@/features/retrieval/citation-list";
import { ConfidenceBadge } from "@/features/retrieval/confidence-badge";
import { citation } from "./fixtures";

describe("grounded answer evidence", () => {
  it.each(["high", "medium", "low", "insufficient"] as const)("renders %s confidence", (level) => {
    render(<ConfidenceBadge confidence={{ level, score: 0.72, answerable: level !== "insufficient", reasons: ["multi_signal_agreement"] }} />);
    expect(screen.getByText(level)).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    expect(screen.getByText("multi signal agreement")).toBeInTheDocument();
  });

  it("renders citation metadata, expands a real preview, and copies its path", async () => {
    render(<CitationList citations={[citation]} context={[{ filePath: "src/auth/login.ts", language: "typescript", content: "export function authenticate() {}", startLine: 8, endLine: 30, score: 0.9 }]} />);
    expect(screen.getByText("src/auth/login.ts")).toBeInTheDocument();
    expect(screen.getByText(/Lines 10–24/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^1 src\/auth\/login.ts/i }));
    expect(screen.getByText("export function authenticate() {}")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy path src/auth/login.ts" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("src/auth/login.ts:10-24");
  });

  it("does not invent a citation preview", () => {
    render(<CitationList citations={[citation]} />);
    fireEvent.click(screen.getByRole("button", { name: /^1 src\/auth\/login.ts/i }));
    expect(screen.queryByRole("code")).not.toBeInTheDocument();
    expect(screen.queryByText(/preview was not included/i)).not.toBeInTheDocument();
    expect(vi.mocked(navigator.clipboard.writeText)).not.toHaveBeenCalledWith("invented");
  });
});
