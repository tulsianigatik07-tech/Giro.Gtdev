import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeIndexingStream, parseSseBlock, subscribeToIndexing } from "@/services/sse/indexing-events";
import type { IndexingProgress } from "@/types/api";

describe("indexing SSE", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("parses named progress events", () => {
    expect(parseSseBlock('event: progress\ndata: {"stage":"embedding"}')).toEqual({ event: "progress", data: '{"stage":"embedding"}' });
  });

  it("parses default and multiline data events while ignoring heartbeats and comments", () => {
    expect(parseSseBlock(': heartbeat')).toBeNull();
    expect(parseSseBlock('event: heartbeat\ndata: {}')).toEqual({ event: "heartbeat", data: "{}" });
    expect(parseSseBlock('data: {"stage":\ndata: "embedding"}')).toEqual({ event: "message", data: '{"stage":\n"embedding"}' });
  });

  it("delivers progress updates and stops at completion", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode('event: progress\ndata: {"jobId":"job-1","repositoryId":"acme/platform","stage":"embedding","percentage":65,"message":"Embedding","timestamp":"2026-07-17T00:00:00Z"}\n\n'));
      controller.enqueue(encoder.encode('event: completed\ndata: {"jobId":"job-1","repositoryId":"acme/platform","stage":"completed","percentage":100,"message":"Done","timestamp":"2026-07-17T00:01:00Z"}\n\n'));
      controller.close();
    }});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const updates: IndexingProgress[] = [];
    await consumeIndexingStream("acme/platform", "token", { onProgress: (event) => updates.push(event) }, new AbortController().signal);
    expect(updates.map((event) => event.stage)).toEqual(["embedding", "completed"]);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("acme%2Fplatform/indexing/events"), expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token" }) }));
  });

  it("stops after a terminal failure event", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode('event: failed\ndata: {"jobId":"job-1","repositoryId":"acme/platform","stage":"failed","percentage":40,"message":"Clone failed","timestamp":"2026-07-17T00:00:00Z"}\n\n'));
      controller.close();
    }});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const updates: IndexingProgress[] = [];
    await consumeIndexingStream("acme/platform", "token", { onProgress: (event) => updates.push(event) }, new AbortController().signal);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ stage: "failed", message: "Clone failed" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reconnects after a nonterminal disconnect and preserves the last progress", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const stream = (frame: string) => new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode(frame));
      controller.close();
    }});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(stream('event: progress\ndata: {"jobId":"job-1","repositoryId":"acme/platform","stage":"cloning","percentage":10,"message":"Cloning","timestamp":"2026-07-17T00:00:00Z"}\n\n'), { status: 200 }))
      .mockResolvedValueOnce(new Response(stream('event: completed\ndata: {"jobId":"job-1","repositoryId":"acme/platform","stage":"completed","percentage":100,"message":"Done","timestamp":"2026-07-17T00:01:00Z"}\n\n'), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const updates: IndexingProgress[] = [];
    const reconnect = vi.fn();
    const subscription = subscribeToIndexing("acme/platform", "token", { onProgress: (event) => updates.push(event), onReconnect: reconnect }, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await subscription;
    expect(reconnect).toHaveBeenCalledWith(1, 1_000);
    expect(updates.map((event) => event.stage)).toEqual(["cloning", "completed"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not reconnect terminal authorization errors", async () => {
    const unauthorized = vi.fn();
    window.addEventListener("giro:unauthorized", unauthorized, { once: true });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: false,
      error: { code: "invalid_token", message: "Invalid token" },
      requestId: "req-sse-auth",
    }), { status: 401, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    await subscribeToIndexing("acme/platform", "token", { onProgress: vi.fn(), onError }, new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ status: 401, requestId: "req-sse-auth" }));
    expect(unauthorized).toHaveBeenCalledOnce();
  });
});
