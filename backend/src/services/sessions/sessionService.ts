// Session business logic. Owns mutation rules; delegates persistence to SessionStore.

import { randomUUID } from "node:crypto";
import { logger } from "../../lib/logger.js";
import { sessionStore } from "./store.js";
import type { SessionStore } from "./store/sessionStore.js";
import type {
  AddMessageInput,
  CreateSessionInput,
  Message,
  SelectedContextChunk,
  Session,
  SessionSummary,
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

const store: SessionStore = sessionStore;

export function createNewSession(input: CreateSessionInput): Session {
  const timestamp = nowIso();
  const session: Session = {
    id: randomUUID(),
    userId: input.userId,
    owner: input.owner,
    repo: input.repo,
    title: input.title ?? `${input.owner}/${input.repo} session`,
    createdAt: timestamp,
    updatedAt: timestamp,
    messages: [],
    selectedContext: [],
  };

  const created = store.createSession(session);
  logger.info("session_created", {
    sessionId: created.id,
    repository: `${input.owner}/${input.repo}`,
  });
  return created;
}

export function getSessionById(id: string): Session | null {
  return store.getSession(id);
}

export function listAllSessions(): SessionSummary[] {
  return store.listSessions().map((s) => ({
    id: s.id,
    userId: s.userId,
    owner: s.owner,
    repo: s.repo,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messageCount: s.messages.length,
  }));
}

export function addMessageToSession(
  sessionId: string,
  input: AddMessageInput,
): Session | null {
  const session = store.getSession(sessionId);
  if (!session) return null;

  const message: Message = {
    id: randomUUID(),
    role: input.role,
    content: input.content,
    citations: input.citations ?? [],
    createdAt: nowIso(),
  };

  const saved = store.appendMessage(sessionId, message, nowIso());
  if (!saved) return null;

  logger.info("session_message_added", {
    sessionId,
    messageId: message.id,
    role: message.role,
  });
  return saved;
}

export function replaceSelectedContext(
  sessionId: string,
  chunks: SelectedContextChunk[],
): Session | null {
  const session = store.getSession(sessionId);
  if (!session) return null;

  const updated: Session = {
    ...session,
    selectedContext: [...chunks],
    updatedAt: nowIso(),
  };

  const saved = store.updateSession(updated);
  logger.info("selected_context_updated", {
    sessionId,
    chunkCount: chunks.length,
  });
  return saved;
}

export function removeSession(id: string): boolean {
  return store.deleteSession(id);
}
