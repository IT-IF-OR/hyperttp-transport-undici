import { Pool, Dispatcher } from "undici";
import type {
  HyperTransport,
  InternalRequest,
  Method,
  RetryOptions,
  TransportRequest,
  TransportResponse,
  TransportResponsePayload,
} from "@hyperttp/types";
import type { DispatchResult, TransportConfig } from "./types/index.js";

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_RETRY_STATUS_CODES = [502, 503, 504];
const RETRYABLE_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

const IDENTITY_HEADERS_TO_DROP_ON_BODYLESS_REDIRECT = new Set([
  "content-type",
  "content-length",
  "transfer-encoding",
  "expect",
]);

const AUTH_HEADERS_TO_DROP_ON_CROSS_ORIGIN_REDIRECT = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
]);

// Расширяем интерфейс опций для поддержки специфичных для Node/Undici параметров
declare module "@hyperttp/types" {
  interface HttpClientOptions {
    /**
     * @ru Базовый URL для резолва относительных путей запросов.
     * @en Base URL used to resolve relative request paths.
     */
    baseUrl?: string; /**
     * @ru Экземпляр диспетчера Undici (Pool, Agent, Client) для низкоуровневой настройки сетевого пула.
     * @en An Undici dispatcher instance (Pool, Agent, or Client) for low-level network pool tuning.
     */
    dispatcher?: Dispatcher;
  }
}

function toOrigin(url: string): string {
  return new URL(url, "http://localhost").origin;
}

function normalizeMethod(method: string): Method {
  return method.toUpperCase() as Method;
}

export function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);

  if (!headers) return out;

  const appendHeader = (key: string, rawValue: unknown): void => {
    const lower = key.toLowerCase();
    if (!lower) return;
    if (rawValue === undefined || rawValue === null) return;

    const value = typeof rawValue === "string" ? rawValue : String(rawValue);
    const existing = out[lower];

    if (existing === undefined) {
      out[lower] = value;
      return;
    }

    out[lower] =
      lower === "set-cookie"
        ? `${existing}\n${value}`
        : `${existing}, ${value}`;
  };

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const key = headers[i];
      const value = headers[i + 1];
      if (typeof key !== "string" || !key) continue;
      appendHeader(key, value);
    }
    return out;
  }

  const headerObj = headers as Record<string, string | string[] | undefined>;

  for (const [key, val] of Object.entries(headerObj)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      for (const item of val) appendHeader(key, item);
    } else {
      appendHeader(key, val);
    }
  }

  return out;
}

export function isRedirect(status: number): boolean {
  return REDIRECT_STATUS_CODES.has(status);
}

export function shouldRetry(
  status: number,
  retryOptions: RetryOptions,
): boolean {
  const codes = retryOptions.retryStatusCodes;
  if (codes && codes.length > 0) {
    return codes.includes(status);
  }

  return DEFAULT_RETRY_STATUS_CODES.includes(status);
}

export function calcDelay(attempt: number, retryOptions: RetryOptions): number {
  const { baseDelay = 1000, maxDelay = 10000, jitter = true } = retryOptions;

  const base = Math.min(baseDelay * 2 ** attempt, maxDelay);
  return jitter ? base * (0.75 + Math.random() * 0.5) : base;
}

function isReadableStreamLike(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).getReader === "function"
  );
}

function isAsyncIterable(value: unknown): boolean {
  if (value == null || typeof value !== "object") return false;

  const asyncIterator = Reflect.get(value as object, Symbol.asyncIterator);

  return typeof asyncIterator === "function";
}

function isReplayableBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body === "string") return true;
  if (body instanceof Buffer) return true;
  if (body instanceof Uint8Array) return true;
  if (body instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(body)) return true;
  if (
    typeof URLSearchParams !== "undefined" &&
    body instanceof URLSearchParams
  ) {
    return true;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) return true;
  if (typeof FormData !== "undefined" && body instanceof FormData) return true;

  if (isReadableStreamLike(body)) return false;
  if (isAsyncIterable(body)) return false;
  if (typeof body === "function") return false;

  return true;
}

function isBodyAllowedForRetry(method: Method, body: unknown): boolean {
  if (body === undefined || body === null) return true;
  return isReplayableBody(body) || method === "GET" || method === "HEAD";
}

function isBodyAllowedForRedirect(method: Method, body: unknown): boolean {
  if (body === undefined || body === null) return true;
  return isReplayableBody(body) || method === "GET" || method === "HEAD";
}

export async function drainBody(body: unknown): Promise<void> {
  if (!body || typeof body !== "object") return;

  try {
    const stream = body as Record<string, unknown>;

    if (typeof stream.dump === "function") {
      await (stream.dump as () => Promise<void>)();
      return;
    }

    if (typeof stream.cancel === "function") {
      await (stream.cancel as () => Promise<void>)();
      return;
    }

    if (typeof stream.resume === "function") {
      (stream.resume as () => void)();
      return;
    }

    if (typeof stream.destroy === "function") {
      (stream.destroy as () => void)();
    }
  } catch {
    // ignore disposal noise
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = (): void => {
      cleanup();
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      reject(err);
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        reject(err);
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export function combineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal?: AbortSignal;
  cancelTimer: () => void;
  cleanup: () => void;
  isTimeoutAbort: () => boolean;
} {
  if (timeoutMs <= 0) {
    return {
      signal,
      cancelTimer: () => {},
      cleanup: () => {},
      isTimeoutAbort: () => false,
    };
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  if (!signal) {
    return {
      signal: timeoutController.signal,
      cancelTimer: () => clearTimeout(timer),
      cleanup: () => clearTimeout(timer),
      isTimeoutAbort: () => timeoutController.signal.aborted,
    };
  }

  if (typeof AbortSignal.any === "function") {
    const combined = AbortSignal.any([signal, timeoutController.signal]);
    return {
      signal: combined,
      cancelTimer: () => clearTimeout(timer),
      cleanup: () => clearTimeout(timer),
      isTimeoutAbort: () => timeoutController.signal.aborted,
    };
  }

  const controller = new AbortController();

  const abortFromUser = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };

  const abortFromTimeout = (): void => {
    if (!controller.signal.aborted) controller.abort();
  };

  if (signal.aborted) {
    abortFromUser();
  } else {
    signal.addEventListener("abort", abortFromUser, { once: true });
  }

  timeoutController.signal.addEventListener("abort", abortFromTimeout, {
    once: true,
  });

  return {
    signal: controller.signal,
    cancelTimer: () => clearTimeout(timer),
    cleanup: () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortFromUser);
      timeoutController.signal.removeEventListener("abort", abortFromTimeout);
    },
    isTimeoutAbort: () => timeoutController.signal.aborted,
  };
}

class UndiciTransportResponse implements TransportResponse {
  public readonly status: number;
  public readonly headers: Record<string, string>;
  public readonly url: string;
  public readonly body: TransportResponsePayload;

  private readonly _rawBody: Buffer;
  private _cachedText?: string;
  private _cachedJson?: unknown;
  private _cachedJsonReady = false;

  constructor(result: DispatchResult) {
    this.status = result.status;
    this.headers = result.headers;
    this.url = result.url;
    this._rawBody = result.body;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(result.body);
        controller.close();
      },
    });

    this.text = this.text.bind(this);
    this.json = this.json.bind(this);
    this.dump = this.dump.bind(this);

    const bodyPayload = stream as unknown as TransportResponsePayload;
    bodyPayload!.dump = this.dump.bind(this);

    this.body = bodyPayload;
  } /**
   * В Web Streams API для прекращения чтения потока используется .cancel()
   */

  public async dump(): Promise<void> {
    if (this.body && typeof this.body.cancel === "function") {
      await this.body.cancel();
    }
  }

  public async text(): Promise<string> {
    if (this._cachedText === undefined) {
      this._cachedText = this._rawBody.toString("utf-8");
    }
    return this._cachedText;
  }

  public async json<T>(): Promise<T> {
    if (this._cachedJsonReady) {
      return this._cachedJson as T;
    }

    const text = await this.text();
    if (!text.trim()) {
      this._cachedJson = null;
      this._cachedJsonReady = true;
      return null as unknown as T;
    }

    this._cachedJson = JSON.parse(text);
    this._cachedJsonReady = true;
    return this._cachedJson as T;
  }
}

export class UndiciDispatchHandler implements Dispatcher.DispatchHandler {
  private statusCode = 200;
  private headers: Record<string, string> = Object.create(null);
  private chunks: Buffer[] = [];

  constructor(
    private readonly resolve: (value: DispatchResult) => void,
    private readonly reject: (reason: Error) => void,
    private readonly url: string,
    private readonly signal?: AbortSignal,
  ) {}

  onRequestStart(
    _controller: Dispatcher.DispatchController,
    _context: unknown,
  ): void {}

  onResponseStart(
    _controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: unknown,
    _statusMessage?: string,
  ): void {
    this.statusCode = statusCode;
    this.headers = normalizeHeaders(headers);
  }

  onResponseData(
    controller: Dispatcher.DispatchController,
    chunk: Buffer,
  ): boolean {
    if (this.signal?.aborted) {
      const abortError = new Error("The operation was aborted.");
      abortError.name = "AbortError";

      controller.abort(abortError);

      return false;
    }

    this.chunks.push(Buffer.from(chunk));

    return true;
  }

  onResponseEnd(
    _controller: Dispatcher.DispatchController,
    _trailers: unknown,
  ): void {
    const body = Buffer.concat(this.chunks);

    this.resolve({
      status: this.statusCode,
      headers: this.headers,
      body,
      url: this.url,
    });
  }

  onResponseError(
    _controller: Dispatcher.DispatchController,
    error: Error,
  ): void {
    this.reject(error);
  }
}

function stripHeadersOnRedirect(
  headers: Record<string, string | string[]>,
  bodyless: boolean,
  crossOrigin: boolean,
): Record<string, string> {
  const next: Record<string, string> = Object.create(null);

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();

    if (bodyless && IDENTITY_HEADERS_TO_DROP_ON_BODYLESS_REDIRECT.has(lower)) {
      continue;
    }

    if (
      crossOrigin &&
      AUTH_HEADERS_TO_DROP_ON_CROSS_ORIGIN_REDIRECT.has(lower)
    ) {
      continue;
    }

    next[lower] = Array.isArray(value) ? value.join(", ") : value;
  }

  return next;
}

export class UndiciTransport implements HyperTransport {
  public config: TransportConfig;
  private readonly pool: Dispatcher;
  private readonly isExternal: boolean;

  constructor(config: TransportConfig) {
    this.config = config;
    this.isExternal = config.dispatcher !== undefined;

    const origin = toOrigin(this.baseUrl);

    this.pool =
      config.dispatcher ??
      new Pool(origin, {
        connections: config.network?.maxConcurrent ?? 500,
        pipelining: config.network?.pipelining ?? 8,
        keepAliveTimeout: config.network?.keepAliveTimeout ?? 30000,
      });
  }

  private get baseUrl(): string {
    return this.config.baseUrl ?? "http://localhost:3000";
  }

  private get timeout(): number {
    return this.config.network?.timeout ?? 30000;
  }

  private get followRedirects(): boolean {
    return this.config.network?.followRedirects ?? true;
  }

  private get maxRedirects(): number {
    return this.config.network?.maxRedirects ?? 5;
  }

  private get retryOptions(): RetryOptions {
    return this.config.retry ?? {};
  }

  private get maxRetries(): number {
    return this.config.retry?.maxRetries ?? 3;
  }

  public async execute(req: TransportRequest): Promise<TransportResponse> {
    return this.executeWithPolicy({
      url: req.url,
      method: normalizeMethod(req.method),
      headers: { ...req.headers }, // Защита от мутаций оригинального объекта
      body: req.body,
      signal: req.signal,
    });
  }

  private async executeWithPolicy(
    req: InternalRequest,
  ): Promise<TransportResponse> {
    let currentUrl = req.url;
    let currentMethod = normalizeMethod(req.method);
    let currentHeaders = { ...req.headers };
    let currentBody = req.body;

    let redirects = 0;
    let attempt = 0; // Один общий таймаут на весь запрос, включая редиректы и ретраи

    const { signal, cancelTimer, cleanup, isTimeoutAbort } = combineSignal(
      req.signal,
      this.timeout,
    );

    try {
      while (true) {
        const startedAt = Date.now();

        try {
          const result = await this.dispatchOnce({
            ...req,
            url: currentUrl,
            method: currentMethod,
            headers: currentHeaders,
            body: currentBody,
            signal,
          });

          if (this.followRedirects && isRedirect(result.status)) {
            if (redirects >= this.maxRedirects) {
              throw new Error("Too many redirects");
            }

            const location = result.headers.location;
            if (location) {
              const nextUrl = new URL(location, result.url).toString();
              const nextOrigin = new URL(nextUrl).origin;
              const currentOrigin = new URL(result.url).origin;

              let nextMethod = currentMethod;
              let nextBody = currentBody;
              let bodylessRedirect = false;

              if (
                result.status === 303 ||
                ((result.status === 301 || result.status === 302) &&
                  currentMethod === "POST")
              ) {
                nextMethod = "GET";
                nextBody = undefined;
                bodylessRedirect = true;
              }

              if (nextMethod !== "GET" && nextMethod !== "HEAD") {
                if (!isBodyAllowedForRedirect(nextMethod, nextBody)) {
                  throw new Error(
                    "Cannot resend non-replayable request body after redirect",
                  );
                }
              }

              currentUrl = nextUrl;
              currentMethod = nextMethod;
              currentBody = nextBody;

              currentHeaders = stripHeadersOnRedirect(
                currentHeaders,
                bodylessRedirect ||
                  nextMethod === "GET" ||
                  nextMethod === "HEAD",
                nextOrigin !== currentOrigin,
              );

              redirects += 1;
              await drainBody(result.body);
              continue;
            }
          }

          if (shouldRetry(result.status, this.retryOptions)) {
            if (
              attempt < this.maxRetries &&
              isBodyAllowedForRetry(currentMethod, currentBody)
            ) {
              await drainBody(result.body);

              const delay = calcDelay(attempt, this.retryOptions);
              const elapsed = Date.now() - startedAt;
              const remainingDelay = Math.max(0, delay - elapsed);

              await sleep(remainingDelay, signal);
              attempt += 1;
              continue;
            }
          }

          return this.createResponse(result);
        } catch (err) {
          if (this.isAbortError(err)) {
            if (req.signal?.aborted) {
              throw err;
            }

            if (isTimeoutAbort()) {
              throw new Error(`Request timeout after ${this.timeout}ms`, {
                cause: err,
              });
            }

            throw new Error("Transport closed or aborted", { cause: err });
          }

          const code = this.getErrorCode(err);

          if (
            attempt < this.maxRetries &&
            code &&
            RETRYABLE_ERROR_CODES.has(code) &&
            isBodyAllowedForRetry(currentMethod, currentBody)
          ) {
            const delay = calcDelay(attempt, this.retryOptions);
            await sleep(delay, signal);
            attempt += 1;
            continue;
          }

          throw err;
        }
      }
    } finally {
      cancelTimer();
      cleanup();
    }
  }

  private async dispatchOnce(req: InternalRequest): Promise<DispatchResult> {
    const fullUrl = new URL(req.url, this.baseUrl);

    const body = (req.body ??
      null) as unknown as Dispatcher.DispatchOptions["body"];

    const dispatchOptions: Dispatcher.DispatchOptions = {
      origin: fullUrl.origin,
      path: fullUrl.pathname + fullUrl.search,
      method: req.method as Method,
      headers: req.headers,
      body,
    };

    if (req.signal?.aborted) {
      const abortError = new Error("The operation was aborted.");
      abortError.name = "AbortError";
      throw abortError;
    }

    return new Promise<DispatchResult>((resolve, reject) => {
      try {
        this.pool.dispatch(
          dispatchOptions,
          new UndiciDispatchHandler(
            resolve,
            reject,
            fullUrl.toString(),
            req.signal,
          ),
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private createResponse(result: DispatchResult): TransportResponse {
    return new UndiciTransportResponse(result);
  }

  private isAbortError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;

    const name = (err as { name?: unknown }).name;
    const code = (err as { code?: unknown }).code;
    const cause = (err as { cause?: unknown }).cause;

    return (
      name === "AbortError" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT" ||
      (cause !== undefined && this.isAbortError(cause))
    );
  }

  private getErrorCode(err: unknown): string | undefined {
    if (!err || typeof err !== "object") return undefined;

    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;

    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) return this.getErrorCode(cause);

    return undefined;
  }

  public async close(): Promise<void> {
    if (this.isExternal) return;
    await this.pool.close();
  }

  public async destroy(): Promise<void> {
    if (this.isExternal) return;
    await this.pool.destroy();
  }
}
