import test from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryHealthText } from "../services/repository/repositoryHealthText.js";
import type { RepositoryHealthSummary } from "../services/repository/repositoryHealthSummary.js";

function health(overrides?: Partial<RepositoryHealthSummary>): RepositoryHealthSummary {
  return {
    scale: "small",
    complexity: "low",
    fileCoverage: 4,
    dependencyDensity: 1,
    healthScore: 100,
    healthCategory: "excellent",
    ...overrides,
  };
}

function expected(h: RepositoryHealthSummary): string {
  return [
    "Repository health:",
    `- Scale: ${h.scale}`,
    `- Complexity: ${h.complexity}`,
    `- File coverage: ${h.fileCoverage}`,
    `- Dependency density: ${h.dependencyDensity}`,
    `- Health score: ${h.healthScore}`,
    `- Health category: ${h.healthCategory}`,
  ].join("\n");
}

test("1. excellent-health text (full exact string)", () => {
  const h = health();
  assert.equal(
    buildRepositoryHealthText(h),
    "Repository health:\n" +
      "- Scale: small\n" +
      "- Complexity: low\n" +
      "- File coverage: 4\n" +
      "- Dependency density: 1\n" +
      "- Health score: 100\n" +
      "- Health category: excellent",
  );
});

test("2. good-health text", () => {
  const h = health({
    scale: "medium",
    complexity: "medium",
    fileCoverage: 2,
    dependencyDensity: 1,
    healthScore: 80,
    healthCategory: "good",
  });
  assert.equal(buildRepositoryHealthText(h), expected(h));
});

test("3. fair-health text", () => {
  const h = health({
    scale: "large",
    complexity: "high",
    fileCoverage: 0.4,
    dependencyDensity: 1,
    healthScore: 50,
    healthCategory: "fair",
  });
  assert.equal(buildRepositoryHealthText(h), expected(h));
});

test("4. poor-health text", () => {
  const h = health({
    scale: "large",
    complexity: "high",
    fileCoverage: 0.4,
    dependencyDensity: 12,
    healthScore: 25,
    healthCategory: "poor",
  });
  assert.equal(
    buildRepositoryHealthText(h),
    "Repository health:\n" +
      "- Scale: large\n" +
      "- Complexity: high\n" +
      "- File coverage: 0.4\n" +
      "- Dependency density: 12\n" +
      "- Health score: 25\n" +
      "- Health category: poor",
  );
});

test("5. exact full-string equality (mixed fixture)", () => {
  const h = health({
    scale: "medium",
    complexity: "medium",
    fileCoverage: 2.5,
    dependencyDensity: 6.25,
    healthScore: 70,
    healthCategory: "good",
  });
  assert.equal(buildRepositoryHealthText(h), expected(h));
});

test("6. all six fields rendered in correct lines/order", () => {
  const lines = buildRepositoryHealthText(
    health({
      scale: "large",
      complexity: "high",
      fileCoverage: 3.14,
      dependencyDensity: 9.99,
      healthScore: 42,
      healthCategory: "poor",
    }),
  ).split("\n");
  assert.equal(lines[0], "Repository health:");
  assert.equal(lines[1], "- Scale: large");
  assert.equal(lines[2], "- Complexity: high");
  assert.equal(lines[3], "- File coverage: 3.14");
  assert.equal(lines[4], "- Dependency density: 9.99");
  assert.equal(lines[5], "- Health score: 42");
  assert.equal(lines[6], "- Health category: poor");
});

test("7. decimal values preserved; whole numbers not forced to .00", () => {
  const decimal = buildRepositoryHealthText(health({ fileCoverage: 0.33, dependencyDensity: 0.67 }));
  assert.match(decimal, /^- File coverage: 0\.33$/m);
  assert.match(decimal, /^- Dependency density: 0\.67$/m);

  const whole = buildRepositoryHealthText(health({ fileCoverage: 2, dependencyDensity: 5 }));
  assert.match(whole, /^- File coverage: 2$/m);
  assert.doesNotMatch(whole, /- File coverage: 2\.00/);
  assert.match(whole, /^- Dependency density: 5$/m);
});

test("8. deterministic: repeated calls return identical string", () => {
  const h = health();
  assert.equal(buildRepositoryHealthText(h), buildRepositoryHealthText(h));
});

test("9. input object is not mutated", () => {
  const h = health();
  const snapshot = JSON.parse(JSON.stringify(h));
  buildRepositoryHealthText(h);
  assert.deepEqual(h, snapshot);
});

test("10. no leading/trailing blank lines: exactly 7 lines, no trailing newline", () => {
  const text = buildRepositoryHealthText(health());
  const lines = text.split("\n");
  assert.equal(lines.length, 7);
  assert.equal(lines[0], "Repository health:");
  assert.ok(!text.startsWith("\n"));
  assert.ok(!text.endsWith("\n"));
});

test("11. JSON round-trip of health produces identical text", () => {
  const h = health({ fileCoverage: 0.33, dependencyDensity: 2 });
  const roundTripped = JSON.parse(JSON.stringify(h)) as RepositoryHealthSummary;
  assert.equal(buildRepositoryHealthText(h), buildRepositoryHealthText(roundTripped));
});
