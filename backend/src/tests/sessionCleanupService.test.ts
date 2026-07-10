import { test } from "node:test";
import assert from "node:assert/strict";

import { findSessionCleanupCandidates } from "../services/sessions/sessionCleanupService.js";

test("session cleanup service returns cleanup candidates array", () => {
  const result = findSessionCleanupCandidates();

  assert.equal(Array.isArray(result), true);
});

test("session cleanup service returns cleanup candidates with required fields", () => {
  const result = findSessionCleanupCandidates();

  for (const candidate of result) {
    assert.equal(typeof candidate.sessionId, "string");
    assert.equal(typeof candidate.reason, "string");
  }
});
