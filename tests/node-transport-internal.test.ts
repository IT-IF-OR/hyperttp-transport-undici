import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { UndiciTransport } from "../src/index.js";
import type { TransportRequest } from "@hyperttp/types";
import { combineSignal } from "../src/utils/helper.js";

const BASE_URL = "http://localhost:3000";

describe("NodeTransport - Internal Configurations & Mocking", () => {
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

  it("handles custom retry status codes", async () => {
    transport.config.retry = {
      maxRetries: 1,
      retryStatusCodes: [418],
      baseDelay: 1,
      jitter: false,
    };

    mockAgent.get(BASE_URL).intercept({ path: "/teapot" }).reply(418, "Teapot");
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/teapot" })
      .reply(200, "Recovered");

    const response = await transport.execute(makeRequest({ url: "/teapot" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("Recovered");
  });

  it("supports disabling timeouts with timeout <= 0", async () => {
    transport.config.network = { timeout: 0 };
    mockAgent.get(BASE_URL).intercept({ path: "/no-timeout" }).reply(200, "ok");

    const response = await transport.execute(
      makeRequest({ url: "/no-timeout" }),
    );
    expect(response.status).toBe(200);
  });

  it("handles alternative AbortSignal fallback branch", async () => {
    const originalAny = AbortSignal.any;
    Object.defineProperty(AbortSignal, "any", {
      value: undefined,
      configurable: true,
    });

    try {
      mockAgent
        .get(BASE_URL)
        .intercept({ path: "/fallback-signal" })
        .reply(200, "ok");

      const controller = new AbortController();
      const response = await transport.execute({
        url: "/fallback-signal",
        method: "GET",
        headers: {},
        signal: controller.signal,
      });

      expect(response.status).toBe(200);
    } finally {
      Object.defineProperty(AbortSignal, "any", {
        value: originalAny,
        configurable: true,
      });
    }
  });

  it("drains mock streams inside drainBody during redirect via hook", async () => {
    const fakeStream = { dump: vi.fn().mockResolvedValue(undefined) };
    const originalDispatch = transport["pool"].dispatch.bind(transport["pool"]);

    vi.spyOn(transport["pool"], "dispatch").mockImplementation(
      (options, handler) => {
        if (options.path === "/redirect-dump") {
          (handler as any).resolve({
            status: 302,
            headers: { location: "/target" },
            body: fakeStream,
            url: `${BASE_URL}/redirect-dump`,
          });
          return true;
        }
        return originalDispatch(options, handler);
      },
    );

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/target" })
      .reply(200, "success");

    const response = await transport.execute(
      makeRequest({ url: "/redirect-dump" }),
    );
    expect(response.status).toBe(200);
    expect(fakeStream.dump).toHaveBeenCalled();

    vi.restoreAllMocks();
  });

  it("triggers timeout via setTimeout and throws correct error", async () => {
    vi.useFakeTimers();
    transport.config.network = { timeout: 1000 };

    const dispatchSpy = vi
      .spyOn(transport["pool"], "dispatch")
      .mockImplementation((options, handler) => {
        const signal = (options as any).signal;
        if (signal) {
          const onAbort = () => {
            const abortError = new Error("The operation was aborted.");
            abortError.name = "AbortError";
            handler.onResponseError?.(null as any, abortError);
          };

          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
          }
        }
        return true;
      });

    const promise = transport.execute(makeRequest({ url: "/hang" }));

    await Promise.all([
      vi.advanceTimersByTimeAsync(1001),
      expect(promise).rejects.toThrow("Request timeout after 1000ms"),
    ]);

    vi.useRealTimers();
    dispatchSpy.mockRestore();
  });

  it("explicitly hits maximum redirects and drains body", async () => {
    transport.config.network = { maxRedirects: 1, followRedirects: true };

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/r1" })
      .reply(302, "drain me", { headers: { location: "/r2" } });

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/r2" })
      .reply(302, "drain me too", { headers: { location: "/r3" } });

    await expect(
      transport.execute(makeRequest({ url: "/r1" })),
    ).rejects.toThrow("Too many redirects");
  });

  it("throws generic transport closed or aborted error on untracked aborts", async () => {
    const controller = new AbortController();

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/internal-abort" })
      .replyWithError(
        Object.assign(new Error("Aborted"), { name: "AbortError" }),
      );

    const promise = transport.execute({
      url: "/internal-abort",
      method: "GET",
      headers: {},
      signal: controller.signal,
    });

    await expect(promise).rejects.toThrow("Transport closed or aborted");
  });

  it("throws AbortError immediately if signal is pre-aborted before dispatching", async () => {
    const controller = new AbortController();
    controller.abort(); // Абортим ДО выполнения

    const promise = transport.execute({
      url: "/pre-aborted",
      method: "GET",
      headers: {},
      signal: controller.signal,
    });

    await expect(promise).rejects.toThrow("The operation was aborted.");
  });

  it("handles non-object errors gracefully inside catch blocks", async () => {
    vi.spyOn(transport["pool"], "dispatch").mockImplementation(() => {
      throw "primitive string error";
    });

    const promise = transport.execute(makeRequest({ url: "/primitive-error" }));

    await expect(promise).rejects.toBe("primitive string error");

    vi.restoreAllMocks();
  });

  it("returns null for empty JSON body and uses cached value on consecutive calls", async () => {
    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/empty-json-cached" })
      .reply(204, "");

    const response = await transport.execute(
      makeRequest({ url: "/empty-json-cached" }),
    );

    const firstCall = await response.json();
    const secondCall = await response.json();

    expect(firstCall).toBeNull();
    expect(secondCall).toBeNull();
  });

  it("covers combinedSignal event listener and disabled timeout abort helper", async () => {
    transport.config.network = { timeout: 0 };

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/zero-timeout-abort" })
      .replyWithError(
        Object.assign(new Error("Aborted"), { name: "AbortError" }),
      );

    const controller = new AbortController();

    const promise = transport.execute({
      url: "/zero-timeout-abort",
      method: "GET",
      headers: {},
      signal: controller.signal,
    });

    controller.abort();

    await expect(promise).rejects.toThrow();
  });

  it("explicitly executes sleep delay and continues to next retry iteration", async () => {
    vi.useFakeTimers();

    transport.config.retry = {
      maxRetries: 1,
      baseDelay: 500,
      jitter: false,
    };

    const networkError = new Error("connection reset");
    (networkError as any).code = "ECONNRESET";

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/explicit-retry" })
      .replyWithError(networkError);

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/explicit-retry" })
      .reply(200, "success");

    const promise = transport.execute(makeRequest({ url: "/explicit-retry" }));

    await vi.advanceTimersByTimeAsync(500);

    const response = await promise;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("success");

    vi.useRealTimers();
  });

  it("supports disabling timeouts with timeout <= 0", async () => {
    transport.config.network = { timeout: 0 };
    const combined = combineSignal(undefined, 0);
    expect(combined.isTimeoutAbort()).toBe(false);

    mockAgent
      .get(BASE_URL)
      .intercept({ path: "/zero-timeout" })
      .reply(200, "ok");
    const res = await transport.execute(makeRequest({ url: "/zero-timeout" }));
    expect(res.status).toBe(200);
  });
});
