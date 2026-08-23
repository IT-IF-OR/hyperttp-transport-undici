import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";

import { UndiciTransport } from "../src/index.js";
import type { TransportRequest, TransportResponse } from "@hyperttp/types";

const BASE_URL = "http://127.0.0.1:3099";

function makeRequest(
  req: Partial<TransportRequest> & { url: string },
): TransportRequest {
  const { protocol = "rest", ...request } = req;

  return {
    method: "GET",
    headers: {},
    ...request,
    protocol,
  };
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
}

async function readBody(response: TransportResponse): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body as AsyncIterable<Buffer>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function startTestServer() {
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", BASE_URL);

      if (url.pathname === "/json") {
        json(res, 200, { ok: true, path: url.pathname });
        return;
      }

      if (url.pathname === "/text") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("hello text");
        return;
      }

      if (url.pathname === "/headers") {
        const custom = req.headers["x-custom"];
        json(res, 200, { header: custom ?? null });
        return;
      }

      if (url.pathname === "/post") {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        json(res, 201, { method: req.method, body });
        return;
      }

      if (url.pathname === "/slow") {
        setTimeout(() => {
          json(res, 200, { slow: true });
        }, 200);
        return;
      }

      if (url.pathname === "/not-found") {
        json(res, 404, { error: "Not Found" });
        return;
      }

      json(res, 200, { path: url.pathname });
    },
  );

  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  server.listen(3099, "127.0.0.1");
  await once(server, "listening");

  return server;
}

describe("UndiciTransport (real pool)", () => {
  let server: Awaited<ReturnType<typeof startTestServer>>;
  let transport: UndiciTransport;

  beforeAll(async () => {
    server = await startTestServer();
    transport = new UndiciTransport({
      baseUrl: BASE_URL,
      network: {
        maxConcurrent: 8,
        pipelining: 1,
        keepAliveTimeout: 1_000,
      },
    });
  });

  afterAll(async () => {
    await transport.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("executes GET and exposes the raw JSON body", async () => {
    const response = await transport.execute(makeRequest({ url: "/json" }));

    expect(response.status).toBe(200);
    expect(JSON.parse(await readBody(response))).toEqual({
      ok: true,
      path: "/json",
    });
  });

  it("returns raw text body", async () => {
    const response = await transport.execute(makeRequest({ url: "/text" }));

    expect(response.status).toBe(200);
    expect(await readBody(response)).toBe("hello text");
  });

  it("passes headers through", async () => {
    const response = await transport.execute(
      makeRequest({
        url: "/headers",
        headers: { "x-custom": "abc123" },
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(await readBody(response))).toEqual({ header: "abc123" });
  });

  it("sends POST body", async () => {
    const response = await transport.execute(
      makeRequest({
        url: "/post",
        method: "POST",
        body: JSON.stringify({ foo: "bar" }),
      }),
    );

    expect(response.status).toBe(201);
    expect(JSON.parse(await readBody(response))).toEqual({
      method: "POST",
      body: JSON.stringify({ foo: "bar" }),
    });
  });

  it("returns 404 as a normal response", async () => {
    const response = await transport.execute(
      makeRequest({ url: "/not-found" }),
    );

    expect(response.status).toBe(404);
    expect(JSON.parse(await readBody(response))).toEqual({
      error: "Not Found",
    });
  });

  it("aborts a request via AbortController", async () => {
    const controller = new AbortController();

    const promise = transport.execute(
      makeRequest({
        url: "/slow",
        signal: controller.signal,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    controller.abort();

    await expect(promise).rejects.toThrow();
  });

  it("can be closed and recreated cleanly", async () => {
    await transport.close();

    transport = new UndiciTransport({
      baseUrl: BASE_URL,
      network: {
        maxConcurrent: 8,
        pipelining: 1,
        keepAliveTimeout: 1_000,
      },
    });

    const response = await transport.execute(makeRequest({ url: "/json" }));

    expect(response.status).toBe(200);
    expect(JSON.parse(await readBody(response))).toEqual({
      ok: true,
      path: "/json",
    });
  });
});
