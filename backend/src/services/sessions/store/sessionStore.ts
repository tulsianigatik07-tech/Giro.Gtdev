import type { Message, Session } from "../types.js";

export interface SessionStore {
  createSession(session: Session): Session;
  getSession(id: string): Session | null;
  listSessions(): Session[];
  updateSession(session: Session): Session;
  deleteSession(id: string): boolean;
  appendMessage(sessionId: string, message: Message, updatedAt: string): Session | null;
  clear(): void;
}
