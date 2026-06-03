// Pure in-memory storage for sessions. No business logic lives here.

import type { Session } from "./types.js";

const sessions = new Map<string, Session>();

function clone(session: Session): Session {
  // Shallow-copy the session and its array fields so callers can't mutate
  // the stored reference.
  return {
    ...session,
    messages: [...session.messages],
    selectedContext: [...session.selectedContext],
  };
}

export function createSession(session: Session): Session {
  sessions.set(session.id, clone(session));
  return clone(session);
}

export function getSession(id: string): Session | null {
  const found = sessions.get(id);
  return found ? clone(found) : null;
}

export function listSessions(): Session[] {
  return [...sessions.values()]
    .map(clone)
    .sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
}

export function updateSession(session: Session): Session {
  sessions.set(session.id, clone(session));
  return clone(session);
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}

export function clearAllSessions(): void {
  sessions.clear();
}
