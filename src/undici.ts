import { Pool, Dispatcher } from "undici";
import { Readable } from "node:stream";
import type {
  HyperTransport,
  InternalRequest,
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

// Расширяем интерфейс опций для поддержки специфичных для Node/Undici параметров
declare module "@hyperttp/types" {
  interface HttpClientOptions {
    /**
     * @ru Базовый URL для резолва относительных путей запросов.
     * @en Base URL used to resolve relative request paths.
     */
    baseUrl?: string;
    /**
     * @ru Экземпляр диспетчера Undici (Pool, Agent, Client) для низкоуровневой настройки сетевого пула.
     * @en An Undici dispatcher instance (Pool, Agent, or Client) for low-level network pool tuning.
     */
    dispatcher?: Dispatcher;
  }
}

export function normalizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = Object.create(null);

  if (!headers) return out;

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const key = (headers[i] as string).toLowerCase();
      if (!key) continue;

      const value = headers[i + 1];
      if (value === undefined || value === null) continue;

      out[key] = typeof value === "string" ? value : String(value);
    }
    return out;
  }

  const headerObj = headers as Record<string, string | string[] | undefined>;

  for (const [key, val] of Object.entries(headerObj)) {
    if (val === undefined) continue;

    const lower = key.toLowerCase();

    if (Array.isArray(val)) {
      out[lower] = lower === "set-cookie" ? val.join("\n") : val.join(", ");
    } else {
      out[lower] = String(val);
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

export async function drainBody(body: unknown): Promise<void> {
  if (!body || typeof body !== "object") return;

  try {
    const stream = body as Record<string, unknown>;

    if (typeof stream.dump === "function") {
      await (stream.dump as () => Promise<void>)();
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function combineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal?: AbortSignal;
  cancelTimer: () => void;
  isTimeoutAbort: () => boolean;
} {
  if (timeoutMs <= 0) {
    return {
      signal,
      cancelTimer: () => {},
      isTimeoutAbort: () => false,
    };
  }

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  let combinedSignal: AbortSignal;
  if (signal) {
    if (typeof AbortSignal.any === "function") {
      combinedSignal = AbortSignal.any([signal, timeoutController.signal]);
    } else {
      signal.addEventListener("abort", () => timeoutController.abort(), {
        once: true,
      });
      combinedSignal = timeoutController.signal;
    }
  } else {
    combinedSignal = timeoutController.signal;
  }

  return {
    signal: combinedSignal,
    cancelTimer: () => clearTimeout(timer),
    isTimeoutAbort: () => timeoutController.signal.aborted,
  };
}

class UndiciTransportResponse implements TransportResponse {
  public readonly status: number;
  public readonly headers: Record<string, string>;
  public readonly url: string;
  public readonly body: TransportResponsePayload;
  public readonly baseUrl: string;

  private readonly _rawBody: Buffer;
  private _cachedText?: string;
  private _cachedJson?: unknown;
  private _cachedJsonReady = false;

  constructor(result: DispatchResult) {
    this.status = result.status;
    this.headers = result.headers;
    this.url = result.url;
    this._rawBody = result.body;
    this.body = Readable.from([
      result.body,
    ]) as unknown as TransportResponsePayload;
    this.baseUrl = result.url;
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

  public onRequestStart(
    _controller: Dispatcher.DispatchController,
    _context: unknown,
  ): void {}

  public onResponseStart(
    _controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: unknown,
    _statusMessage?: string,
  ): void {
    this.statusCode = statusCode;
    this.headers = normalizeHeaders(headers);
  }

  public onResponseData(
    controller: Dispatcher.DispatchController,
    chunk: Buffer,
  ): void {
    if (this.signal?.aborted) {
      const abortError = new Error("The operation was aborted.");
      abortError.name = "AbortError";
      controller.abort(abortError);
      return;
    }
    this.chunks.push(chunk);
  }

  public onResponseEnd(
    _controller: Dispatcher.DispatchController,
    _trailers: Record<string, string>,
  ): void {
    const body =
      this.chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(this.chunks);

    this.resolve({
      status: this.statusCode,
      headers: this.headers,
      body,
      url: this.url,
    });
  }

  public onResponseError(
    _controller: Dispatcher.DispatchController,
    error: Error,
  ): void {
    this.reject(error);
  }
}

export class UndiciTransport implements HyperTransport {
  public config: TransportConfig;
  private readonly pool: Dispatcher;
  private readonly isExternal: boolean;

  constructor(config: TransportConfig) {
    this.config = config;
    this.isExternal = config.dispatcher !== undefined;

    this.pool =
      config.dispatcher ??
      new Pool(this.baseUrl, {
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
      method: req.method,
      headers: { ...req.headers }, // Защита от мутаций оригинального объекта
      body: req.body,
      signal: req.signal,
    });
  }

  private async executeWithPolicy(
    req: InternalRequest,
  ): Promise<TransportResponse> {
    let currentUrl = req.url;
    let currentMethod = req.method;
    let currentHeaders = req.headers;
    let currentBody = req.body;

    let redirects = 0;
    let attempt = 0;

    while (true) {
      const { signal, cancelTimer, isTimeoutAbort } = combineSignal(
        req.signal,
        this.timeout,
      );

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
            await drainBody(result.body);
            throw new Error("Too many redirects");
          }

          const location = result.headers.location;
          if (location) {
            await drainBody(result.body);

            const nextUrl = new URL(location, result.url).toString();
            let nextMethod = currentMethod;

            if (
              result.status === 303 ||
              ((result.status === 301 || result.status === 302) &&
                currentMethod === "POST")
            ) {
              nextMethod = "GET";
            }

            currentUrl = nextUrl;
            currentMethod = nextMethod;
            currentBody = nextMethod === "GET" ? undefined : currentBody;

            if (nextMethod === "GET") {
              const nextHeaders = { ...currentHeaders };
              delete nextHeaders["content-type"];
              delete nextHeaders["content-length"];
              currentHeaders = nextHeaders;
            }

            redirects += 1;
            continue;
          }
        }

        if (shouldRetry(result.status, this.retryOptions)) {
          if (attempt < this.maxRetries) {
            await drainBody(result.body);
            await sleep(calcDelay(attempt, this.retryOptions));
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
          RETRYABLE_ERROR_CODES.has(code)
        ) {
          await sleep(calcDelay(attempt, this.retryOptions));
          attempt += 1;
          continue;
        }

        throw err;
      } finally {
        cancelTimer();
      }
    }
  }

  private async dispatchOnce(req: InternalRequest): Promise<DispatchResult> {
    const fullUrl = new URL(req.url, this.baseUrl);

    const dispatchOptions = {
      origin: fullUrl.origin,
      path: fullUrl.pathname + fullUrl.search,
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: req.signal,
    };

    if (req.signal?.aborted) {
      const abortError = new Error("The operation was aborted.");
      abortError.name = "AbortError";
      throw abortError;
    }

    return new Promise<DispatchResult>((resolve, reject) => {
      // Полностью полагаемся на внутренний механизм отмены undici через dispatchOptions.signal.
      // Это предотвращает двойной reject и утечки памяти.
      this.pool.dispatch(
        dispatchOptions,
        new UndiciDispatchHandler(
          resolve,
          reject,
          fullUrl.toString(),
          req.signal,
        ),
      );
    });
  }

  private createResponse(result: DispatchResult): TransportResponse {
    return new UndiciTransportResponse(result);
  }

  private isAbortError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const name = (err as { name?: unknown }).name;
    const code = (err as { code?: unknown }).code;
    return (
      name === "AbortError" ||
      code === "UND_ERR_HEADERS_TIMEOUT" ||
      code === "UND_ERR_BODY_TIMEOUT"
    );
  }

  private getErrorCode(err: unknown): string | undefined {
    if (!err || typeof err !== "object") return undefined;
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
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
