import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { Readable } from "node:stream";
import { UndiciTransport } from "../src/index.js";
import type { TransportRequest, TransportResponse } from "@hyperttp/types";

const BASE_URL = "http://localhost:3000";

async function readBody(response: TransportResponse): Promise<string> {
  const body = response.body as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("UndiciTransport - Neutral Contract", () => {
  let mockAgent: MockAgent;
  let transport: UndiciTransport;
  let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

  const makeRequest = (req: Partial<TransportRequest> & { url: string }): TransportRequest => {
    const { protocol = "rest", ...request } = req;

    return {
      method: "GET",
      headers: {},
      ...request,
      protocol,
    };
  };

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

  it("executes GET and exposes the raw body stream", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/json", method: "GET" })
      .reply(200, JSON.stringify({ ok: true, hello: "world" }), {
        headers: { "content-type": "application/json" },
      });

    const response = await transport.execute(makeRequest({ url: "/json" }));
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(await readBody(response))).toEqual({
      ok: true,
      hello: "world",
    });
  });

  it("returns raw text body", async () => {
    mockAgent.get(BASE_URL).intercept({ path: "/text" }).reply(200, "plain text body");
    const response = await transport.execute(makeRequest({ url: "/text" }));
    expect(await readBody(response)).toBe("plain text body");
  });

  it("returns empty string for empty body", async () => {
    mockAgent.get(BASE_URL).intercept({ path: "/empty-text" }).reply(200, "");
    const response = await transport.execute(makeRequest({ url: "/empty-text" }));
    expect(await readBody(response)).toBe("");
  });

  it("does not parse the body (invalid JSON is returned raw)", async () => {
    mockAgent.get(BASE_URL).intercept({ path: "/invalid-json" }).reply(200, "{invalid json");
    const response = await transport.execute(makeRequest({ url: "/invalid-json" }));
    expect(await readBody(response)).toBe("{invalid json");
  });

  it("normalizes response headers to lowercase", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/headers" })
      .reply(200, JSON.stringify({ ok: true }), {
        headers: { "X-Test": "hello", "Content-Type": "application/json" },
      });

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
      .reply(200, "ok");

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
      .reply(201, JSON.stringify({ created: true }));

    const response = await transport.execute(
      makeRequest({
        url: "/post",
        method: "POST",
        body: JSON.stringify({ foo: "bar" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(JSON.parse(await readBody(response))).toEqual({ created: true });
  });

  it("supports Buffer body", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({
        path: "/buffer",
        method: "POST",
        body: (body: unknown) => Buffer.from(body as string).toString() === "hello",
      })
      .reply(200, "ok");

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
    mockAgent.get(BASE_URL).intercept({ path: "/stream", method: "POST" }).reply(200, "ok");
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
      .reply(404, JSON.stringify({ error: "Not Found" }));
    const response = await transport.execute(makeRequest({ url: "/not-found" }));
    expect(response.status).toBe(404);
    expect(JSON.parse(await readBody(response))).toEqual({
      error: "Not Found",
    });
  });

  it("supports relative and absolute URLs", async () => {
    mockAgent.get(BASE_URL).intercept({ path: "/relative" }).reply(200, "ok");
    const res1 = await transport.execute(makeRequest({ url: "/relative" }));
    expect(res1.status).toBe(200);

    mockAgent.get(BASE_URL).intercept({ path: "/absolute" }).reply(200, "ok");
    const res2 = await transport.execute(makeRequest({ url: `${BASE_URL}/absolute` }));
    expect(res2.status).toBe(200);
  });

  it("exposes body as a Web ReadableStream", async () => {
    mockAgent.get(BASE_URL).intercept({ path: "/stream-response" }).reply(200, "hello world");
    const response = await transport.execute(makeRequest({ url: "/stream-response" }));
    const body = response.body as ReadableStream<Uint8Array>;

    expect(body).not.toBeInstanceOf(Readable);
    expect(typeof body.getReader).toBe("function");

    const reader = body.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toBe("hello world");
  });

  it("normalizes rawRequest body to a Web ReadableStream", async () => {
    mockAgent.get(BASE_URL).intercept({ path: "/raw-stream" }).reply(200, "hello raw");
    const response = await transport.rawRequest("/raw-stream", "GET");
    const body = response.body as ReadableStream<Uint8Array>;

    expect(body).not.toBeInstanceOf(Readable);
    expect(typeof body.getReader).toBe("function");

    const { value, done } = await body.getReader().read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value)).toBe("hello raw");
  });

  it("propagates dispatcher errors", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/socket-error" })
      .replyWithError(new Error("socket exploded"));
    await expect(transport.execute(makeRequest({ url: "/socket-error" }))).rejects.toThrow(
      "socket exploded",
    );
  });

  it("supports AbortSignal cancellation", async () => {
    const controller = new AbortController();
    const promise = transport.execute({
      url: "/abort",
      method: "GET",
      protocol: "rest",
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
    mockAgent.get(BASE_URL).intercept({ path: "/concurrent" }).reply(200, "ok").persist();

    const total = 100;
    const results = await Promise.all(
      Array.from({ length: total }, () => transport.execute(makeRequest({ url: "/concurrent" }))),
    );

    expect(results).toHaveLength(total);
    for (const response of results) {
      expect(response.status).toBe(200);
    }
  });
});
