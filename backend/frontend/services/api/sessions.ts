import { apiRequest } from "./client";
import type { AskResult, Session, SessionSummary } from "@/types/api";

export const sessionsApi = {
  list(token: string) {
    return apiRequest<{ sessions: SessionSummary[]; count: number }>("/sessions", { method: "GET", token });
  },
  get(token: string, sessionId: string) {
    return apiRequest<Session>(`/sessions/${encodeURIComponent(sessionId)}`, { method: "GET", token });
  },
  create(token: string, input: { owner: string; repo: string; title?: string }) {
    return apiRequest<Session>("/sessions", { method: "POST", token, body: JSON.stringify(input) });
  },
  remove(token: string, sessionId: string) {
    return apiRequest<{ id: string; deleted: true }>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      token,
    });
  },
  ask(token: string, sessionId: string, question: string) {
    return apiRequest<AskResult>(`/sessions/${encodeURIComponent(sessionId)}/ask`, {
      method: "POST",
      token,
      body: JSON.stringify({ question }),
    });
  },
};
