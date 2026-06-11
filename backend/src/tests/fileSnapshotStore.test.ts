import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  saveRepositoryFileSnapshot,
  getRepositoryFileSnapshot,
  clearRepositoryFileSnapshots,
} from "../services/repository/fileSnapshotStore.js";
import type { ScannedFile } from "../services/repository/scanner.js";

const REPO = "acme/demo";

function scanned(filePath: string): ScannedFile {
  return { filePath, size: 42, language: ".ts" };
}

beforeEach(() => {
  clearRepositoryFileSnapshots();
});

test("11. first save creates snapshot", () => {
  saveRepositoryFileSnapshot(REPO, [scanned("a.ts"), scanned("b.ts")]);
  const snap = getRepositoryFileSnapshot(REPO);
  assert.ok(snap);
  assert.equal(snap?.files.length, 2);
  assert.equal(snap?.files[0]?.filePath, "a.ts");
  assert.notEqual(snap?.updatedAt, undefined);
  // lastSeenAt is populated on each stored file.
  assert.ok(snap?.files.every((f) => typeof f.lastSeenAt === "string" && f.lastSeenAt.length > 0));
});

test("12. second save overwrites existing snapshot", () => {
  saveRepositoryFileSnapshot(REPO, [scanned("a.ts"), scanned("b.ts")]);
  saveRepositoryFileSnapshot(REPO, [scanned("c.ts")]);
  const snap = getRepositoryFileSnapshot(REPO);
  assert.equal(snap?.files.length, 1);
  assert.equal(snap?.files[0]?.filePath, "c.ts");
});

test("13. returned snapshot is isolated from store mutations", () => {
  saveRepositoryFileSnapshot(REPO, [scanned("a.ts")]);
  const snap = getRepositoryFileSnapshot(REPO);
  // Mutate the returned object.
  snap?.files.push({ filePath: "hacked.ts", size: 0, language: ".ts", lastSeenAt: "x" });
  if (snap?.files[0]) snap.files[0].filePath = "tampered.ts";

  const fresh = getRepositoryFileSnapshot(REPO);
  assert.equal(fresh?.files.length, 1);
  assert.equal(fresh?.files[0]?.filePath, "a.ts");
});

test("14. clearRepositoryFileSnapshots resets state", () => {
  saveRepositoryFileSnapshot(REPO, [scanned("a.ts")]);
  clearRepositoryFileSnapshots();
  assert.equal(getRepositoryFileSnapshot(REPO), null);
});
