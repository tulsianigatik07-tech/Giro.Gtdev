import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkApplicationReadiness,
  type ReadinessCheckDefinition,
} from "../services/health/readinessService.js";

function check(
  name: string,
  options: {
    critical?: boolean;
    failure?: unknown;
    skip?: boolean;
  } = {},
): ReadinessCheckDefinition {
  return {
    name,
    critical: options.critical ?? true,
    successMessage: `${name} is available.`,
    failureMessage: `${name} is unavailable.`,
    skipMessage: `${name} is not configured.`,
    check: options.skip
      ? undefined
      : () => {
          if (options.failure !== undefined) throw options.failure;
        },
  };
}

test("all critical checks passing returns ready in definition order", async () => {
  const result = await checkApplicationReadiness([
    check("database"),
    check("indexing_store"),
    check("openai_configuration"),
  ]);

  assert.equal(result.status, "ready");
  assert.deepEqual(
    result.checks.map((item) => [item.name, item.status]),
    [
      ["database", "pass"],
      ["indexing_store", "pass"],
      ["openai_configuration", "pass"],
    ],
  );
});

test("critical database, indexing store, and required configuration failures are not ready", async () => {
  for (const name of ["database", "indexing_store", "openai_configuration"]) {
    const result = await checkApplicationReadiness([
      check(name, { failure: new Error("failure") }),
    ]);
    assert.equal(result.status, "not_ready");
    assert.equal(result.checks[0]?.status, "fail");
  }
});

test("non-critical failure degrades readiness", async () => {
  const result = await checkApplicationReadiness([
    check("database"),
    check("optional_metrics", { critical: false, failure: new Error("down") }),
  ]);

  assert.equal(result.status, "degraded");
});

test("skipped optional dependency does not fail readiness", async () => {
  const result = await checkApplicationReadiness([
    check("database"),
    check("optional_metrics", { critical: false, skip: true }),
  ]);

  assert.equal(result.status, "ready");
  assert.equal(result.checks[1]?.status, "skip");
});

test("dependency exceptions are normalized without secret or stack leakage", async () => {
  const secret = "sk-production-secret";
  const providerError = new Error(`fetch failed ${secret} https://db.example.test`);
  providerError.stack = `Error: ${secret}\n at /private/service.ts:10`;

  const result = await checkApplicationReadiness([
    check("database", { failure: providerError }),
  ]);
  const serialized = JSON.stringify(result);

  assert.deepEqual(result.checks[0], {
    name: "database",
    status: "fail",
    critical: true,
    message: "database is unavailable.",
  });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("db.example"), false);
  assert.equal(serialized.includes("service.ts"), false);
});

test("repeated reads are stable and returned models are immutable", async () => {
  const definitions = [check("database"), check("optional", { critical: false, skip: true })];
  const first = await checkApplicationReadiness(definitions);
  const second = await checkApplicationReadiness(definitions);

  assert.deepEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.checks), true);
  assert.equal(Object.isFrozen(first.checks[0]), true);
});
