import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { UndiciTransport } from "../src/index.js";
import type { TransportRequest } from "@hyperttp/types";

const BASE_URL = "http://localhost:3000";

describe("UndiciTransport - Internal Configuration & Mocking", () => {
  let mockAgent: MockAgent;
  let transport: UndiciTransport;
  let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

  const makeRequest = (
    req: Partial<TransportRequest> & { url: string },
  ): TransportRequest => {
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

  it("passes correct dispatch options to the external dispatcher", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/dispatch-check", method: "POST" })
      .reply(200, "ok");

    const signal = new AbortController().signal;
    const dispatchSpy = vi.spyOn(mockAgent, "dispatch");

    await transport.execute(
      makeRequest({
        url: "/dispatch-check",
        method: "POST",
        headers: { "x-custom": "abc" },
        body: "payload",
        signal,
      }),
    );

    const opts = dispatchSpy.mock.calls[0]![0] as {
      origin: string;
      path: string;
      method: string;
      headers: Record<string, string>;
      body: unknown;
      signal: AbortSignal;
    };
    expect(opts.origin).toBe(BASE_URL);
    expect(opts.path).toBe("/dispatch-check");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({ "x-custom": "abc" });
    expect(opts.body).toBe("payload");
    expect(opts.signal).toBe(signal);
  });

  it("preserves query strings in the dispatched path", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/search?q=1&lang=ru" })
      .reply(200, "ok");

    const dispatchSpy = vi.spyOn(mockAgent, "dispatch");
    await transport.execute(makeRequest({ url: "/search?q=1&lang=ru" }));

    const opts = dispatchSpy.mock.calls[0]![0] as { path: string };
    expect(opts.path).toBe("/search?q=1&lang=ru");
  });

  it("throws AbortError immediately if signal is pre-aborted before dispatching", async () => {
    const controller = new AbortController();
    controller.abort();

    const dispatchSpy = vi.spyOn(mockAgent, "dispatch");

    await expect(
      transport.execute({
        url: "/pre-aborted",
        method: "GET",
        protocol: "rest",
        headers: {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("propagates primitive rejection values from the dispatcher", async () => {
    vi.spyOn(mockAgent, "request").mockRejectedValue("primitive string error");

    const promise = transport.execute(makeRequest({ url: "/primitive-error" }));

    await expect(promise).rejects.toBe("primitive string error");

    vi.restoreAllMocks();
  });
});
