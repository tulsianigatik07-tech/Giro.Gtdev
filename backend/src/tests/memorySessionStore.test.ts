import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { MemorySessionStore } from "../services/sessions/store/memorySessionStore.js";
import type { Message, Session } from "../services/sessions/types.js";

const CREATED_AT = "2026-01-01T00:00:00.000Z";

let store: MemorySessionStore;

function session(
  id: string,
  updatedAt = CREATED_AT,
  owner = "acme",
  repo = "demo",
): Session {
  return {
    id,
    userId: "user-a",
    owner,
    repo,
    title: `${owner}/${repo}`,
    createdAt: CREATED_AT,
    updatedAt,
    messages: [],
    selectedContext: [],
  };
}

function message(id: string, content = "hello"): Message {
  return {
    id,
    role: "user",
    content,
    citations: [
      {
        filePath: "src/app.ts",
        startLine: 1,
        endLine: 2,
        snippet: "const app = true;",
      },
    ],
    createdAt: "2026-01-01T00:00:01.000Z",
  };
}

beforeEach(() => {
  store = new MemorySessionStore();
});

test("creates and retrieves a session", () => {
  const created = store.createSession(session("session-1"));
  const retrieved = store.getSession("session-1");

  assert.equal(created.id, "session-1");
  assert.deepEqual(retrieved, created);
});

test("appends a message and updates the session timestamp", () => {
  store.createSession(session("session-1"));

  const updated = store.appendMessage(
    "session-1",
    message("message-1"),
    "2026-01-01T00:00:02.000Z",
  );

  assert.ok(updated);
  assert.equal(updated.updatedAt, "2026-01-01T00:00:02.000Z");
  assert.deepEqual(
    updated.messages.map((m) => [m.id, m.content]),
    [["message-1", "hello"]],
  );
});

test("returns null when appending to a missing session", () => {
  assert.equal(
    store.appendMessage("missing", message("message-1"), CREATED_AT),
    null,
  );
});

test("lists sessions in deterministic updatedAt-descending id-ascending order", () => {
  store.createSession(session("session-c", "2026-01-01T00:00:01.000Z"));
  store.createSession(session("session-b", "2026-01-01T00:00:03.000Z"));
  store.createSession(session("session-a", "2026-01-01T00:00:03.000Z"));

  assert.deepEqual(
    store.listSessions().map((s) => s.id),
    ["session-a", "session-b", "session-c"],
  );
});

test("deletes sessions", () => {
  store.createSession(session("session-1"));

  assert.equal(store.deleteSession("session-1"), true);
  assert.equal(store.getSession("session-1"), null);
  assert.equal(store.deleteSession("session-1"), false);
});

test("clears all sessions", () => {
  store.createSession(session("session-1"));
  store.createSession(session("session-2"));

  store.clear();

  assert.deepEqual(store.listSessions(), []);
});

test("returned sessions cannot mutate stored session objects", () => {
  const original = session("session-1");
  original.messages.push(message("external-before-create"));

  const created = store.createSession(original);
  created.messages.push(message("mutated-created"));
  created.selectedContext.push({
    filePath: "src/mutated.ts",
    language: "typescript",
    content: "mutated",
    startLine: 1,
    endLine: 1,
    score: 1,
    signals: { semantic: 1 },
  });
  created.messages[0]?.citations.push({
    filePath: "src/mutated.ts",
    startLine: 9,
    endLine: 9,
    snippet: "mutated",
  });

  const firstRead = store.getSession("session-1");
  assert.ok(firstRead);
  assert.equal(firstRead.messages.length, 1);
  assert.equal(firstRead.messages[0]?.citations.length, 1);
  assert.equal(firstRead.selectedContext.length, 0);

  firstRead.messages[0]!.content = "mutated-read";
  firstRead.messages[0]!.citations[0]!.snippet = "mutated-read";

  const secondRead = store.getSession("session-1");
  assert.ok(secondRead);
  assert.equal(secondRead.messages[0]?.content, "hello");
  assert.equal(secondRead.messages[0]?.citations[0]?.snippet, "const app = true;");
});

test("repeated reads return stable equal snapshots with distinct references", () => {
  store.createSession(session("session-1"));
  store.appendMessage("session-1", message("message-1"), CREATED_AT);

  const first = store.getSession("session-1");
  const second = store.getSession("session-1");

  assert.ok(first);
  assert.ok(second);
  assert.deepEqual(second, first);
  assert.notEqual(second, first);
  assert.notEqual(second.messages, first.messages);
  assert.notEqual(second.messages[0], first.messages[0]);
});
