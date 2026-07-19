import type { Message, Session } from "../types.js";
import type { SessionStore } from "./sessionStore.js";

function cloneMessage(message: Message): Message {
  return {
    ...message,
    citations: message.citations.map((citation) => ({ ...citation })),
    evidence: message.evidence?.map((chunk) => ({
      ...chunk,
      signals: chunk.signals ? { ...chunk.signals } : undefined,
    })),
    retrievalMetadata: message.retrievalMetadata
      ? {
          ...message.retrievalMetadata,
          sourceCounts: { ...message.retrievalMetadata.sourceCounts },
          confidence: message.retrievalMetadata.confidence
            ? {
                ...message.retrievalMetadata.confidence,
                reasons: [...message.retrievalMetadata.confidence.reasons],
              }
            : undefined,
        }
      : undefined,
  };
}

function cloneSession(session: Session): Session {
  return {
    ...session,
    messages: session.messages.map(cloneMessage),
    selectedContext: session.selectedContext.map((chunk) => ({
      ...chunk,
      signals: chunk.signals ? { ...chunk.signals } : undefined,
    })),
  };
}

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();

  createSession(session: Session): Session {
    this.sessions.set(session.id, cloneSession(session));
    return cloneSession(session);
  }

  getSession(id: string): Session | null {
    const found = this.sessions.get(id);
    return found ? cloneSession(found) : null;
  }

  listSessions(): Session[] {
    return [...this.sessions.values()]
      .map(cloneSession)
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      );
  }

  updateSession(session: Session): Session {
    this.sessions.set(session.id, cloneSession(session));
    return cloneSession(session);
  }

  deleteSession(id: string): boolean {
    return this.sessions.delete(id);
  }

  appendMessage(
    sessionId: string,
    message: Message,
    updatedAt: string,
  ): Session | null {
    const existing = this.sessions.get(sessionId);
    if (!existing) return null;

    const updated: Session = {
      ...existing,
      messages: [...existing.messages, cloneMessage(message)],
      updatedAt,
    };

    this.sessions.set(sessionId, updated);
    return cloneSession(updated);
  }

  clear(): void {
    this.sessions.clear();
  }
}
