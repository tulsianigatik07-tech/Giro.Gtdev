// Session storage compatibility API. The persistence boundary is the
// SessionStore interface; this module preserves the historical synchronous
// function surface used by routes and tests.

import { MemorySessionStore } from "./store/memorySessionStore.js";
import type { SessionStore } from "./store/sessionStore.js";
import type { Message, Session } from "./types.js";

export const sessionStore: SessionStore = new MemorySessionStore();

export function createSession(session: Session): Session {
  return sessionStore.createSession(session);
}

export function getSession(id: string): Session | null {
  return sessionStore.getSession(id);
}

export function listSessions(): Session[] {
  return sessionStore.listSessions();
}

export function updateSession(session: Session): Session {
  return sessionStore.updateSession(session);
}

export function deleteSession(id: string): boolean {
  return sessionStore.deleteSession(id);
}

export function appendMessage(
  sessionId: string,
  message: Message,
  updatedAt: string,
): Session | null {
  return sessionStore.appendMessage(sessionId, message, updatedAt);
}

export function clearAllSessions(): void {
  sessionStore.clear();
}
