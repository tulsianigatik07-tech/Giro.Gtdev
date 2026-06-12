import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractSymbols,
  type ExtractedSymbol,
} from "../services/repository/symbolExtractor.js";

function only(content: string): ExtractedSymbol {
  const result = extractSymbols("src/x.ts", content);
  assert.equal(result.length, 1);
  return result[0] as ExtractedSymbol;
}

test("1. exported function", () => {
  const s = only("export function foo() {}");
  assert.deepEqual(s, { name: "foo", kind: "function", exported: true, line: 1 });
});

test("2. non-exported function", () => {
  const s = only("function bar() {}");
  assert.deepEqual(s, { name: "bar", kind: "function", exported: false, line: 1 });
});

test("3. exported async function", () => {
  const s = only("export async function load() {}");
  assert.equal(s.kind, "function");
  assert.equal(s.name, "load");
  assert.equal(s.exported, true);
});

test("4. exported class", () => {
  const s = only("export class User {}");
  assert.deepEqual(s, { name: "User", kind: "class", exported: true, line: 1 });
});

test("5. non-exported class", () => {
  const s = only("class Account {}");
  assert.deepEqual(s, { name: "Account", kind: "class", exported: false, line: 1 });
});

test("6. interface", () => {
  const exported = only("export interface Repo {}");
  assert.equal(exported.kind, "interface");
  assert.equal(exported.exported, true);
  const local = only("interface Hidden {}");
  assert.equal(local.kind, "interface");
  assert.equal(local.exported, false);
});

test("7. type alias", () => {
  const s = only("export type Id = string;");
  assert.deepEqual(s, { name: "Id", kind: "type", exported: true, line: 1 });
});

test("8. generic type alias", () => {
  const s = only("type Box<T> = { value: T };");
  assert.equal(s.kind, "type");
  assert.equal(s.name, "Box");
  assert.equal(s.exported, false);
});

test("9. const variable", () => {
  const exported = only("export const MAX = 10;");
  assert.deepEqual(exported, { name: "MAX", kind: "variable", exported: true, line: 1 });
  const local = only("const min = 1;");
  assert.deepEqual(local, { name: "min", kind: "variable", exported: false, line: 1 });
});

test("10. let and var variables", () => {
  assert.equal(only("let counter = 0;").kind, "variable");
  assert.equal(only("var legacy = 1;").kind, "variable");
});

test("11. multiple symbols in one file", () => {
  const content = [
    "export function a() {}",
    "class B {}",
    "export interface C {}",
    "type D = number;",
    "const e = 5;",
  ].join("\n");
  const result = extractSymbols("src/multi.ts", content);
  assert.deepEqual(
    result.map((s) => `${s.line}:${s.kind}:${s.name}:${s.exported}`),
    [
      "1:function:a:true",
      "2:class:B:false",
      "3:interface:C:true",
      "4:type:D:false",
      "5:variable:e:false",
    ],
  );
});

test("12. empty file returns []", () => {
  assert.deepEqual(extractSymbols("src/empty.ts", ""), []);
});

test("13. file with no declarations returns []", () => {
  const content = "// just a comment\nconsole.log('hi');\nreturn 42;";
  assert.deepEqual(extractSymbols("src/none.ts", content), []);
});

test("14. duplicate names on different lines are both captured", () => {
  const content = ["function dup() {}", "", "function dup() {}"].join("\n");
  const result = extractSymbols("src/dup.ts", content);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((s) => s.line), [1, 3]);
  assert.ok(result.every((s) => s.name === "dup"));
});

test("15. deterministic ordering by line then name", () => {
  const content = ["export const z = 1;", "export const a = 2;"].join("\n");
  const first = extractSymbols("src/order.ts", content);
  const second = extractSymbols("src/order.ts", content);
  assert.deepEqual(first, second);
  // line order preserved (z on line 1, a on line 2)
  assert.deepEqual(first.map((s) => s.name), ["z", "a"]);
});

test("16. inputs are not mutated / no side effects", () => {
  const content = "export function foo() {}\nclass Bar {}";
  const copy = content.slice();
  extractSymbols("src/x.ts", content);
  assert.equal(content, copy);
});
