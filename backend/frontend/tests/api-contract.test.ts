import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, apiRequest } from "@/services/api/client";
import { normalizeApiBaseUrl } from "@/services/api/config";
import { encodeRepositoryId, repositoriesApi } from "@/services/api/repositories";
import { sessionsApi } from "@/services/api/sessions";

function jsonResponse(body: unknown, status = 200, requestId = "req-1") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Request-ID": requestId },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("API contract client", () => {
  it("normalizes the API base URL and rejects malformed values", () => {
    expect(normalizeApiBaseUrl(undefined)).toBe("http://localhost:8000");
    expect(normalizeApiBaseUrl("https://api.giro.dev///")).toBe("https://api.giro.dev");
    expect(() => normalizeApiBaseUrl("not a url")).toThrow(/NEXT_PUBLIC_GIRO_API_URL/);
    expect(() => normalizeApiBaseUrl("https://token@example.com")).toThrow(/without credentials/);
  });

  it("injects the bearer token without putting it in the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { ok: true }, requestId: "req-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await apiRequest<{ ok: boolean }>("/sessions", { method: "GET", token: "secret-token" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("secret-token");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer secret-token");
  });

  it("encodes repository IDs as one owner/repo route parameter", async () => {
    expect(encodeRepositoryId("acme", "platform")).toBe("acme%2Fplatform");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ success: true, data: { summary: null }, requestId: "req-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await repositoriesApi.summary("token", "acme", "platform");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/repositories/acme%2Fplatform/summary");
    expect(fetchMock.mock.calls[0]?.[0]).not.toContain("/repositories/acme/platform/");
  });

  it.each([
    [429, "rate_limit_exceeded"],
    [503, "dependency_unavailable"],
    [504, "request_timeout"],
  ])("normalizes retryable %i errors and preserves request IDs", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      success: false,
      error: { code, message: "Try later", retryable: true },
      requestId: `req-${status}`,
    }, status)));
    await expect(apiRequest("/sessions/id/ask", { method: "POST", token: "token" }))
      .rejects.toMatchObject({ status, code, retryable: true, requestId: `req-${status}` });
  });

  it("preserves validation field errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      success: false,
      error: { code: "validation_failed", message: "Validation failed", details: { fieldErrors: { question: ["question is required"] } } },
      requestId: "req-validation",
    }, 400)));
    const error = await apiRequest("/sessions/id/ask", { method: "POST", token: "token" }).catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ fieldErrors: { question: ["question is required"] }, requestId: "req-validation" });
  });

  it("rejects malformed success envelopes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }, 200, "req-malformed")));
    await expect(apiRequest("/sessions", { method: "GET", token: "token" })).rejects.toMatchObject({
      code: "invalid_response",
      requestId: "req-malformed",
    });
  });

  it("uses the verified session creation, deletion, and ask DTOs", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: "s1" }, requestId: "r1" }, 201))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { id: "s1", deleted: true }, requestId: "r2" }))
      .mockResolvedValueOnce(jsonResponse({ success: true, data: { answer: "Grounded" }, requestId: "r3" }));
    vi.stubGlobal("fetch", fetchMock);
    await sessionsApi.create("token", { owner: "acme", repo: "platform", title: "Architecture" });
    await sessionsApi.remove("token", "s1");
    await sessionsApi.ask("token", "s1", "Where does it start?");
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual(["POST", "DELETE", "POST"]);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).body).toBe(JSON.stringify({ owner: "acme", repo: "platform", title: "Architecture" }));
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/sessions/s1");
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).body).toBe(JSON.stringify({ question: "Where does it start?" }));
  });
});
