import { describe, expect, it } from "vitest";

import { findSessionCleanupCandidates } from "../services/sessions/sessionCleanupService.js";

describe("session cleanup service", () => {
  it("returns cleanup candidates array", () => {
    const result = findSessionCleanupCandidates();

    expect(Array.isArray(result)).toBe(true);
  });

  it("returns cleanup candidates with required fields", () => {
    const result = findSessionCleanupCandidates();

    for (const candidate of result) {
      expect(candidate).toHaveProperty("sessionId");
      expect(candidate).toHaveProperty("reason");
    }
  });
});