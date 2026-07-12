import assert from "node:assert/strict";
import { test } from "node:test";
import { cloneRepo } from "../services/repository/clone.js";

test("clone uses the bounded remaining deadline and preserves timeout classification", async () => {
  let receivedTimeout = 0;
  await assert.rejects(
    cloneRepo("timeout-test-owner", "timeout-test-repo", {
      deadline: {
        signal: new AbortController().signal,
        remainingMs: () => 1_234,
        throwIfExpired: () => undefined,
        dispose: () => undefined,
      },
      executeClone: async (_url, _path, timeoutMs) => {
        receivedTimeout = timeoutMs;
        throw new Error("operation timed out");
      },
    }),
    /Clone failed: operation timed out/,
  );
  assert.equal(receivedTimeout, 1_234);
});
