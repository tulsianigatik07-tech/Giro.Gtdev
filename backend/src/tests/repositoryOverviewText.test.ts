import test from "node:test";
import assert from "node:assert/strict";
import { buildRepositoryOverviewText } from "../services/repository/repositoryOverviewText.js";
import type { RepositoryOverview } from "../services/repository/repositoryOverview.js";

function overview(overrides?: {
  structure?: Partial<RepositoryOverview["structure"]>;
  architecture?: Partial<RepositoryOverview["architecture"]>;
}): RepositoryOverview {
  return {
    structure: {
      totalFiles: 5,
      totalChunks: 10,
      totalSymbols: 7,
      totalGraphNodes: 3,
      totalGraphEdges: 2,
      summaryAvailable: true,
      repositoryScale: "small",
      ...overrides?.structure,
    },
    architecture: {
      totalFiles: 3,
      totalDependencies: 2,
      averageDependenciesPerFile: 0.67,
      isolatedFiles: 1,
      connectedFiles: 2,
      architectureComplexity: "low",
      ...overrides?.architecture,
    },
  };
}

test("1. zero/empty overview -> exact expected string", () => {
  const text = buildRepositoryOverviewText(
    overview({
      structure: {
        totalFiles: 0,
        totalChunks: 0,
        totalSymbols: 0,
        totalGraphNodes: 0,
        totalGraphEdges: 0,
        summaryAvailable: false,
        repositoryScale: "small",
      },
      architecture: {
        totalFiles: 0,
        totalDependencies: 0,
        averageDependenciesPerFile: 0,
        isolatedFiles: 0,
        connectedFiles: 0,
        architectureComplexity: "low",
      },
    }),
  );
  assert.equal(
    text,
    [
      "Repository overview:",
      "- Files: 0",
      "- Chunks: 0",
      "- Symbols: 0",
      "- Graph nodes: 0",
      "- Graph edges: 0",
      "- Scale: small",
      "- Dependencies: 0",
      "- Average dependencies per file: 0",
      "- Connected files: 0",
      "- Isolated files: 0",
      "- Architecture complexity: low",
    ].join("\n"),
  );
});

test("2. small repository overview -> exact string", () => {
  const text = buildRepositoryOverviewText(overview());
  assert.equal(
    text,
    [
      "Repository overview:",
      "- Files: 5",
      "- Chunks: 10",
      "- Symbols: 7",
      "- Graph nodes: 3",
      "- Graph edges: 2",
      "- Scale: small",
      "- Dependencies: 2",
      "- Average dependencies per file: 0.67",
      "- Connected files: 2",
      "- Isolated files: 1",
      "- Architecture complexity: low",
    ].join("\n"),
  );
});

test("3. large repository overview -> exact string", () => {
  const text = buildRepositoryOverviewText(
    overview({
      structure: {
        totalFiles: 400,
        totalChunks: 5000,
        totalSymbols: 9000,
        totalGraphNodes: 400,
        totalGraphEdges: 2000,
        summaryAvailable: true,
        repositoryScale: "large",
      },
      architecture: {
        totalFiles: 400,
        totalDependencies: 2000,
        averageDependenciesPerFile: 5,
        isolatedFiles: 10,
        connectedFiles: 390,
        architectureComplexity: "high",
      },
    }),
  );
  assert.equal(
    text,
    [
      "Repository overview:",
      "- Files: 400",
      "- Chunks: 5000",
      "- Symbols: 9000",
      "- Graph nodes: 400",
      "- Graph edges: 2000",
      "- Scale: large",
      "- Dependencies: 2000",
      "- Average dependencies per file: 5",
      "- Connected files: 390",
      "- Isolated files: 10",
      "- Architecture complexity: high",
    ].join("\n"),
  );
});

test("4. exact full-string equality (medium fixture)", () => {
  const text = buildRepositoryOverviewText(
    overview({
      structure: { totalFiles: 100, repositoryScale: "medium" },
      architecture: { totalDependencies: 300, averageDependenciesPerFile: 3, architectureComplexity: "medium" },
    }),
  );
  const expected =
    "Repository overview:\n" +
    "- Files: 100\n" +
    "- Chunks: 10\n" +
    "- Symbols: 7\n" +
    "- Graph nodes: 3\n" +
    "- Graph edges: 2\n" +
    "- Scale: medium\n" +
    "- Dependencies: 300\n" +
    "- Average dependencies per file: 3\n" +
    "- Connected files: 2\n" +
    "- Isolated files: 1\n" +
    "- Architecture complexity: medium";
  assert.equal(text, expected);
});

test("5. Files line uses structure.totalFiles (not architecture.totalFiles)", () => {
  const text = buildRepositoryOverviewText(
    overview({ structure: { totalFiles: 42 }, architecture: { totalFiles: 999 } }),
  );
  assert.match(text, /^- Files: 42$/m);
  assert.doesNotMatch(text, /- Files: 999/);
});

test("6. architecture values rendered correctly", () => {
  const text = buildRepositoryOverviewText(
    overview({
      architecture: {
        totalFiles: 50,
        totalDependencies: 123,
        averageDependenciesPerFile: 2.46,
        isolatedFiles: 8,
        connectedFiles: 42,
        architectureComplexity: "medium",
      },
    }),
  );
  assert.match(text, /^- Dependencies: 123$/m);
  assert.match(text, /^- Average dependencies per file: 2\.46$/m);
  assert.match(text, /^- Connected files: 42$/m);
  assert.match(text, /^- Isolated files: 8$/m);
  assert.match(text, /^- Architecture complexity: medium$/m);
});

test("7. deterministic: repeated calls return identical string", () => {
  const o = overview();
  assert.equal(buildRepositoryOverviewText(o), buildRepositoryOverviewText(o));
});

test("8. input object is not mutated", () => {
  const o = overview();
  const snapshot = JSON.parse(JSON.stringify(o));
  buildRepositoryOverviewText(o);
  assert.deepEqual(o, snapshot);
});

test("9. no extra/blank lines: exactly 12 lines, no trailing newline", () => {
  const text = buildRepositoryOverviewText(overview());
  const lines = text.split("\n");
  assert.equal(lines.length, 12);
  assert.equal(lines[0], "Repository overview:");
  assert.ok(!text.endsWith("\n"));
  assert.ok(!text.startsWith("\n"));
});

test("10. JSON round-trip of overview produces identical text", () => {
  const o = overview({ structure: { totalFiles: 17 }, architecture: { averageDependenciesPerFile: 0.33 } });
  const roundTripped = JSON.parse(JSON.stringify(o)) as RepositoryOverview;
  assert.equal(buildRepositoryOverviewText(o), buildRepositoryOverviewText(roundTripped));
});

test("11. decimal average preserved (0.33) and whole number unforced (2)", () => {
  const decimal = buildRepositoryOverviewText(overview({ architecture: { averageDependenciesPerFile: 0.33 } }));
  assert.match(decimal, /^- Average dependencies per file: 0\.33$/m);

  const whole = buildRepositoryOverviewText(overview({ architecture: { averageDependenciesPerFile: 2 } }));
  assert.match(whole, /^- Average dependencies per file: 2$/m);
  assert.doesNotMatch(whole, /- Average dependencies per file: 2\.00/);
});
