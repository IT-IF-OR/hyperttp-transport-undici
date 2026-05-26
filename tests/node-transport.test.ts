import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { Readable } from "node:stream";
import { UndiciTransport } from "../src/index.js";
import type { TransportRequest } from "@hyperttp/types";

const BASE_URL = "http://localhost:3000";

describe("NodeTransport - Integration Pipeline", () => {
  let mockAgent: MockAgent;
  let transport: UndiciTransport;
  let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

  const makeRequest = (
    req: Partial<TransportRequest> & { url: string },
  ): TransportRequest => ({
    method: "GET",
    headers: {},
    ...req,
  });

  beforeEach(() => {
    originalDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent({ connections: 10 });
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);

    transport = new UndiciTransport({
      dispatcher: mockAgent,
      baseUrl: BASE_URL,
    });
  });

  afterEach(async () => {
    await transport.close();
    await mockAgent.close();
    setGlobalDispatcher(originalDispatcher);
  });

  it("executes GET and parses JSON", async () => {
    const payload = { ok: true, hello: "world" };

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/json", method: "GET" })
      .reply(200, payload, {
        headers: { "content-type": "application/json" },
      });

    const response = await transport.execute(makeRequest({ url: "/json" }));
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(await response.json()).toEqual(payload);
  });

  it("executes GET and returns text", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/text" })
      .reply(200, "plain text body");
    const response = await transport.execute(makeRequest({ url: "/text" }));
    expect(await response.text()).toBe("plain text body");
  });

  it("returns empty string for empty text body", async () => {
    mockAgent.get(BASE_URL).intercept({ path: "/empty-text" }).reply(200, "");
    const response = await transport.execute(
      makeRequest({ url: "/empty-text" }),
    );
    expect(await response.text()).toBe("");
  });

  it("returns null for empty JSON body", async () => {
    mockAgent.get(BASE_URL).intercept({ path: "/empty-json" }).reply(204, "");
    const response = await transport.execute(
      makeRequest({ url: "/empty-json" }),
    );
    expect(await response.json()).toBeNull();
  });

  it("throws on invalid JSON", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/invalid-json" })
      .reply(200, "{invalid json");
    const response = await transport.execute(
      makeRequest({ url: "/invalid-json" }),
    );
    await expect(response.json()).rejects.toThrow();
  });

  it("normalizes response headers to lowercase", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/headers" })
      .reply(
        200,
        { ok: true },
        {
          headers: { "X-Test": "hello", "Content-Type": "application/json" },
        },
      );

    const response = await transport.execute(makeRequest({ url: "/headers" }));
    expect(response.headers["x-test"]).toBe("hello");
    expect(response.headers["content-type"]).toContain("application/json");
  });

  it("passes request headers through", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({
        path: "/request-headers",
        headers: { authorization: "Bearer token", "x-custom": "hello" },
      })
      .reply(200, { ok: true });

    const response = await transport.execute(
      makeRequest({
        url: "/request-headers",
        headers: { authorization: "Bearer token", "x-custom": "hello" },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("sends POST body correctly", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/post", method: "POST", body: '{"foo":"bar"}' })
      .reply(201, { created: true });

    const response = await transport.execute(
      makeRequest({
        url: "/post",
        method: "POST",
        body: JSON.stringify({ foo: "bar" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ created: true });
  });

  it("supports Buffer body", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({
        path: "/buffer",
        method: "POST",
        body: (body: any) => Buffer.from(body).toString() === "hello",
      })
      .reply(200, { ok: true });

    const response = await transport.execute(
      makeRequest({
        url: "/buffer",
        method: "POST",
        body: Buffer.from("hello"),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("supports Readable stream body", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/stream", method: "POST" })
      .reply(200, { ok: true });
    const response = await transport.execute(
      makeRequest({
        url: "/stream",
        method: "POST",
        body: Readable.from(["hello"]),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("returns 404 and 500 as a normal response", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/not-found" })
      .reply(404, { error: "Not Found" });
    const response = await transport.execute(
      makeRequest({ url: "/not-found" }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not Found" });
  });

  it("supports relative and absolute URLs", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/relative" })
      .reply(200, { ok: true });
    const res1 = await transport.execute(makeRequest({ url: "/relative" }));
    expect(res1.status).toBe(200);

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/absolute" })
      .reply(200, { ok: true });
    const res2 = await transport.execute(
      makeRequest({ url: `${BASE_URL}/absolute` }),
    );
    expect(res2.status).toBe(200);
  });

  it("exposes body as readable stream", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/stream-response" })
      .reply(200, "hello world");
    const response = await transport.execute(
      makeRequest({ url: "/stream-response" }),
    );

    expect(response.body).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const chunk of response.body as any) {
      chunks.push(Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe("hello world");
  });

  it("propagates dispatcher errors", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/socket-error" })
      .replyWithError(new Error("socket exploded"));
    await expect(
      transport.execute(makeRequest({ url: "/socket-error" })),
    ).rejects.toThrow("socket exploded");
  });

  it("supports AbortSignal cancellation", async () => {
    const controller = new AbortController();
    const promise = transport.execute({
      url: "/abort",
      method: "GET",
      signal: controller.signal,
      headers: {},
    });

    queueMicrotask(() => controller.abort());
    await expect(promise).rejects.toThrow();
  });

  it("close() and destroy() do not affect external dispatcher", async () => {
    const closeSpy = vi.spyOn(mockAgent, "close");
    const destroySpy = vi.spyOn(mockAgent, "destroy");

    await transport.close();
    await transport.destroy();

    expect(closeSpy).not.toHaveBeenCalled();
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it("can execute many concurrent requests", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/concurrent" })
      .reply(200, { ok: true })
      .persist();

    const total = 100;
    const results = await Promise.all(
      Array.from({ length: total }, () =>
        transport.execute(makeRequest({ url: "/concurrent" })),
      ),
    );

    expect(results).toHaveLength(total);
    for (const response of results) {
      expect(response.status).toBe(200);
    }
  });

  it("transforms POST to GET on 303 redirect", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/redirect-303", method: "POST" })
      .reply(303, "", { headers: { location: "/target-get" } });
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/target-get", method: "GET" })
      .reply(200, { success: true });

    const response = await transport.execute(
      makeRequest({
        url: "/redirect-303",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foo: "bar" }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("gives up after max retries on 502 status", async () => {
    transport.config.retry = { maxRetries: 2, baseDelay: 1, jitter: false };
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/bad-gateway" })
      .reply(502, "Bad Gateway")
      .times(3);

    const response = await transport.execute(
      makeRequest({ url: "/bad-gateway" }),
    );
    expect(response.status).toBe(502);
  });
});
