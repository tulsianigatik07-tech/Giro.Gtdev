import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

const runner = process.argv[2];
if (runner !== "node" && runner !== "vitest") {
  process.stderr.write("Usage: node scripts/run-test-suite.mjs <node|vitest>\n");
  process.exit(2);
}

async function collectTests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTests(entryPath)));
    if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(entryPath);
  }

  return files;
}

const allTests = await collectTests("src");
const suites = { node: [], vitest: [] };

for (const file of allTests) {
  const source = await readFile(file, "utf8");
  const usesNode = /from\s+["']node:test["']/.test(source);
  const usesVitest = /from\s+["']vitest["']/.test(source);

  if (usesNode === usesVitest) {
    process.stderr.write(`Test file must import exactly one supported runner: ${file}\n`);
    process.exit(2);
  }

  suites[usesNode ? "node" : "vitest"].push(file);
}

const files = suites[runner];
process.stdout.write(`Running ${files.length} ${runner} test files.\n`);

const command = runner === "node" ? "tsx" : "vitest";
const args = runner === "node" ? ["--test", ...files] : ["run", ...files];
const result = spawnSync(command, args, { stdio: "inherit" });

if (result.error) throw result.error;
process.exit(result.status ?? 1);
