import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import {
  createRequestContextMiddleware,
  isValidRequestId,
  REQUEST_ID_HEADER,
  type RequestContextVariables,
} from "../middleware/requestContext.js";

function appWithGenerator(generated = "generated-request-id") {
  const app = new Hono<{ Variables: RequestContextVariables }>();
  app.use("*", createRequestContextMiddleware({
    generateRequestId: () => generated,
    monotonicNow: () => 1,
    logger: { info: () => undefined, error: () => undefined },
  }));
  app.get("/context", (c) => c.json({ requestId: c.get("requestId") }));
  return app;
}

test("valid incoming request ID is preserved in context and response header", async () => {
  const response = await appWithGenerator().request("/context", {
    headers: { "X-Request-ID": "upstream:request-123" },
  });

  assert.equal(response.headers.get(REQUEST_ID_HEADER), "upstream:request-123");
  assert.deepEqual(await response.json(), { requestId: "upstream:request-123" });
});

test("missing request ID uses the injected deterministic generator", async () => {
  const response = await appWithGenerator("deterministic-id").request("/context");

  assert.equal(response.headers.get(REQUEST_ID_HEADER), "deterministic-id");
  assert.deepEqual(await response.json(), { requestId: "deterministic-id" });
});

test("missing request ID generates a UUID by default", async () => {
  const app = new Hono<{ Variables: RequestContextVariables }>();
  app.use("*", createRequestContextMiddleware({
    monotonicNow: () => 1,
    logger: { info: () => undefined, error: () => undefined },
  }));
  app.get("/context", (c) => c.text(c.get("requestId")));

  const response = await app.request("/context");
  const requestId = response.headers.get(REQUEST_ID_HEADER);

  assert.match(requestId ?? "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(await response.text(), requestId);
});

test("malformed incoming IDs are replaced and never echoed", async () => {
  for (const invalid of ["   ", "../unsafe", "has whitespace", "a".repeat(129)]) {
    const response = await appWithGenerator("safe-generated-id").request("/context", {
      headers: { "X-Request-ID": invalid },
    });
    assert.equal(response.headers.get(REQUEST_ID_HEADER), "safe-generated-id");
    assert.notEqual(response.headers.get(REQUEST_ID_HEADER), invalid);
  }
});

test("request ID validation rejects CRLF and control-character injection", () => {
  for (const invalid of [
    "safe\r\nX-Injected: true",
    "safe\nvalue",
    "safe\tvalue",
    "\u0000unsafe",
  ]) {
    assert.equal(isValidRequestId(invalid), false);
  }
});

test("generated response contains exactly one request ID header", async () => {
  const response = await appWithGenerator().request("/context");
  const matchingHeaders = [...response.headers.keys()].filter(
    (name) => name.toLowerCase() === "x-request-id",
  );

  assert.deepEqual(matchingHeaders, ["x-request-id"]);
});
