import { Pool, Dispatcher } from "undici";
import type {
  HyperTransport,
  TransportRequest,
  TransportResponse,
  TransportResponsePayload,
  TransportStreamExtensions,
  StealthOptions,
  Fingerprint,
} from "@hyperttp/types";
import { abortError, createPoolOptions, fastParseUrl, normalizeHeaders } from "./utils/helpers.js";
import type { PoolOptions, UndiciTransportConfig } from "./types/index.js";
import { createDecompressStream } from "./utils/decompress.js";
import net from "node:net";
import tls from "node:tls";

const DEFAULT_BASE_URL = "http://localhost:3000";
const FALLBACK_ORIGIN = "http://localhost";

/**
 * @ru Интерфейс для объектов с методом close().
 * @en Interface for objects with a close() method.
 */
interface Closeable {
  close(): Promise<void>;
}

/**
 * @ru Интерфейс для объектов с методом destroy().
 * @en Interface for objects with a destroy() method.
 */
interface Destroyable {
  destroy(): Promise<void>;
}

type UndiciPoolOptions = NonNullable<ConstructorParameters<typeof Pool>[1]>;
type UndiciConnectorFn = Extract<NonNullable<UndiciPoolOptions["connect"]>, Function>;

/**
 * @ru Статические пресеты браузерных заголовков для маскировки под реальных пользователей.
 * Используются stealth-режимом для обхода fingerprint-защит.
 * @en Static presets of browser headers for masking as real users.
 * Used by stealth mode to bypass fingerprint protections.
 */
const STEALTH_HEADER_PRESETS: Record<string, Record<string, string>> = {
  chrome: {
    "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Linux"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "sec-fetch-user": "?1",
    "upgrade-insecure-requests": "1",
    "accept-language": "en-US,en;q=0.9",
  },
  firefox: {
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    "accept-language": "en-US,en;q=0.5",
    "upgrade-insecure-requests": "1",
  },
};

/**
 * @ru Пресеты User-Agent, соответствующие TLS-отпечаткам (JA3/JA4).
 * @en User-Agent presets matching the TLS fingerprints (JA3/JA4).
 */
const STEALTH_UA_PRESETS: Record<string, string> = {
  chrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  firefox: "Mozilla/5.0 (X11; Linux; rv:126.0) Gecko/20100101 Firefox/126.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  edge: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
};

/**
 * @ru Возвращает строку шифров TLS для указанного профиля браузера.
 * @en Returns the TLS cipher suite string for the specified browser profile.
 * @param fingerprint - Browser fingerprint profile.
 * @returns Colon-separated cipher suite string, or empty string if not found.
 */
function getCiphersForProfile(fingerprint: Fingerprint | undefined): string {
  if (!fingerprint) return "";

  switch (fingerprint) {
    case "chrome":
    case "edge":
      return [
        "TLS_AES_128_GCM_SHA256",
        "TLS_AES_256_GCM_SHA384",
        "TLS_CHACHA20_POLY1305_SHA256",
        "ECDHE-ECDSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES128-GCM-SHA256",
      ].join(":");

    case "firefox":
      return [
        "TLS_AES_128_GCM_SHA256",
        "TLS_CHACHA20_POLY1305_SHA256",
        "TLS_AES_256_GCM_SHA384",
        "ECDHE-ECDSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES128-GCM-SHA256",
      ].join(":");

    case "safari":
      return [
        "TLS_AES_256_GCM_SHA384",
        "TLS_CHACHA20_POLY1305_SHA256",
        "TLS_AES_128_GCM_SHA256",
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES256-GCM-SHA384",
      ].join(":");

    default:
      return "";
  }
}

/**
 * @ru Безопасно применяет stealth-пресеты к заголовкам, отдавая приоритет ручным настройкам.
 * @en Safely applies stealth presets to headers, prioritizing manual overrides.
 * @param headers - The headers object to modify.
 * @param stealth - Stealth configuration options.
 * @returns The modified headers object.
 */
function applyStealthHeaders(
  headers: Record<string, string>,
  stealth: StealthOptions,
): Record<string, string> {
  if (!stealth || !stealth.fingerprint) return headers;

  const presetName = stealth.fingerprint;
  const presetHeaders = STEALTH_HEADER_PRESETS[presetName];

  if (presetHeaders) {
    for (const key in presetHeaders) {
      if (headers[key] === undefined) {
        headers[key] = presetHeaders[key]!;
      }
    }
  }

  const currentUA = headers["user-agent"];
  if (currentUA === undefined || currentUA === "hyperttp/2.0" || currentUA === "Hyperttp/2.0") {
    const browserUA = STEALTH_UA_PRESETS[presetName];
    if (browserUA) {
      headers["user-agent"] = browserUA;
    }
  }

  return headers;
}

/**
 * @ru Обработчик событий Undici Dispatcher, преобразующий низкоуровневые события в TransportResponse.
 * Управляет жизненным циклом стрима, обработкой abort-сигналов и декомпрессией.
 * @en Undici Dispatcher event handler that transforms low-level events into TransportResponse.
 * Manages stream lifecycle, abort signal handling, and decompression.
 */
export class UndiciDispatchHandler implements Dispatcher.DispatchHandler {
  private undiciController: Dispatcher.DispatchController | null = null;
  private streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private onAbortRef?: () => void;
  private isResolved = false;
  private finished = false;

  /**
   * @ru Создаёт обработчик для конкретного запроса.
   * @en Creates a handler for a specific request.
   * @param resolve - Promise resolver for successful response.
   * @param reject - Promise rejector for errors.
   * @param url - The full request URL.
   * @param signal - Optional abort signal.
   */
  constructor(
    private readonly resolve: (value: TransportResponse) => void,
    private readonly reject: (reason: Error) => void,
    private readonly url: string,
    private readonly signal?: AbortSignal,
  ) {}

  /**
   * @ru Вызывается при начале запроса. Устанавливает контроллер и подписывается на abort.
   * @en Called when the request starts. Sets up the controller and subscribes to abort.
   * @param controller - The Undici dispatch controller.
   */
  onRequestStart(controller: Dispatcher.DispatchController): void {
    this.undiciController = controller;
    const signal = this.signal;
    if (!signal) return;

    if (signal.aborted) {
      controller.abort(abortError(signal.reason));
      return;
    }

    this.onAbortRef = () => {
      const err = abortError(signal.reason);
      controller.abort(err);
      const stream = this.streamController;
      if (stream) {
        try {
          stream.error(err);
        } catch {}
      }
    };

    signal.addEventListener("abort", this.onAbortRef, { once: true });
  }

  /**
   * @ru Принудительно вычитывает и закрывает стрим для освобождения сокета.
   * @en Forces stream drain and closure to release the socket.
   */
  private readonly dumpBody = async (): Promise<void> => {
    this.cleanup();
    const controller = this.undiciController;
    if (controller) {
      controller.abort(new Error("Stream dumped"));
    }
    const streamCtrl = this.streamController;
    if (streamCtrl && !this.finished) {
      this.finished = true;
      try {
        streamCtrl.close();
      } catch {}
    }
    this.release();
  };

  /**
   * @ru Вызывается при получении заголовков ответа. Создаёт ReadableStream и запускает декомпрессию.
   * @en Called when response headers are received. Creates a ReadableStream and initiates decompression.
   * @param _controller - The Undici dispatch controller.
   * @param statusCode - HTTP status code.
   * @param headers - Response headers.
   */
  onResponseStart(
    _controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: Record<string, string | string[]>,
  ): void {
    const normalizedHeaders = normalizeHeaders(headers);

    const rawStream = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        this.streamController = ctrl;
        if (this.signal?.aborted) {
          try {
            ctrl.error(abortError(this.signal.reason));
          } catch {}
        }
      },
      cancel: (reason) => {
        this.cleanup();
        if (this.undiciController) {
          this.undiciController.abort(reason instanceof Error ? reason : abortError(reason));
        }
        this.release();
      },
    });

    const ce = normalizedHeaders["content-encoding"];
    const encoding = Array.isArray(ce) ? ce[0] : ce;

    if (encoding) {
      createDecompressStream(rawStream, encoding)
        .then((decompressedStream) => {
          delete normalizedHeaders["content-encoding"];

          if (!this.isResolved) {
            this.isResolved = true;
            this.resolve({
              status: statusCode,
              headers: normalizedHeaders,
              url: this.url,
              body: decompressedStream as TransportResponsePayload,
            });
          }
        })
        .catch((err: Error) => {
          if (this.streamController) {
            try {
              this.streamController.error(err);
            } catch {}
          }
          if (!this.isResolved) {
            this.isResolved = true;
            this.reject(err);
          }
        });
    } else {
      const payload = rawStream as ReadableStream<Uint8Array> & TransportStreamExtensions;
      payload.dump = this.dumpBody;

      this.isResolved = true;
      this.resolve({
        status: statusCode,
        headers: normalizedHeaders,
        url: this.url,
        body: payload as TransportResponsePayload,
      });
    }
  }

  /**
   * @ru Вызывается при получении чанка данных. Добавляет его в стрим.
   * @en Called when a data chunk is received. Enqueues it into the stream.
   * @param _controller - The Undici dispatch controller.
   * @param chunk - The data chunk.
   * @returns True if the chunk was successfully enqueued.
   */
  onResponseData(_controller: Dispatcher.DispatchController, chunk: Buffer): boolean {
    if (this.signal?.aborted) return false;
    const ctrl = this.streamController;
    if (!ctrl) return true;
    try {
      ctrl.enqueue(chunk);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @ru Вызывается при завершении ответа. Закрывает стрим.
   * @en Called when the response ends. Closes the stream.
   */
  onResponseEnd(): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();
    const ctrl = this.streamController;
    if (ctrl) {
      try {
        ctrl.close();
      } catch {}
    }
    this.release();
  }

  /**
   * @ru Вызывается при ошибке. Обрабатывает её до или после разрешения промиса.
   * @en Called on error. Handles it before or after promise resolution.
   * @param _controller - The Undici dispatch controller.
   * @param error - The error that occurred.
   */
  onResponseError(_controller: Dispatcher.DispatchController, error: Error): void {
    if (this.finished) return;
    this.finished = true;
    this.cleanup();

    if (!this.isResolved) {
      this.isResolved = true;
      this.reject(error);
      this.release();
      return;
    }

    const ctrl = this.streamController;
    if (ctrl) {
      try {
        ctrl.error(error);
      } catch {}
    }
    this.release();
  }

  /**
   * @ru Очищает подписки на события abort.
   * @en Cleans up abort event subscriptions.
   */
  private cleanup(): void {
    if (this.signal && this.onAbortRef) {
      this.signal.removeEventListener("abort", this.onAbortRef);
    }
    this.onAbortRef = undefined;
  }

  /**
   * @ru Освобождает ссылки на контроллеры для GC.
   * @en Releases references to controllers for GC.
   */
  private release(): void {
    this.undiciController = null;
    this.streamController = null;
    this.onAbortRef = undefined;
  }
}

/**
 * @ru Транспорт на основе Undici для Node.js с поддержкой пулов соединений, HTTP/2 и stealth-режима.
 * @en Undici-based transport for Node.js with connection pooling, HTTP/2, and stealth mode support.
 */
export class UndiciTransport implements HyperTransport {
  public config: UndiciTransportConfig;
  private readonly pool: Dispatcher;
  private readonly isExternal: boolean;
  private readonly pools = new Map<string, Pool>();
  private readonly poolOptions: PoolOptions;

  /**
   * @ru Создаёт экземпляр UndiciTransport.
   * @en Creates an UndiciTransport instance.
   * @param config - Transport configuration.
   */
  constructor(config: UndiciTransportConfig) {
    this.config = config;
    this.isExternal = config.dispatcher !== undefined;
    this.poolOptions = createPoolOptions(config);

    const parsed = fastParseUrl(this.baseUrl, FALLBACK_ORIGIN);
    this.pool = config.dispatcher ?? this.createNewPool(parsed.origin, config.stealth);
  }

  /**
   * @ru Возвращает базовый URL из конфигурации или дефолтный.
   * @en Returns the base URL from config or the default.
   */
  private get baseUrl(): string {
    return this.config.baseUrl ?? DEFAULT_BASE_URL;
  }

  /**
   * @ru Выполняет HTTP-запрос через Undici dispatcher.
   * @en Executes an HTTP request via Undici dispatcher.
   * @param req - The normalized transport request.
   * @returns Promise resolving to the transport response.
   */
  public async execute(req: TransportRequest): Promise<TransportResponse> {
    const signal = req.signal;
    if (signal?.aborted) {
      throw abortError(signal.reason);
    }

    const parsed = fastParseUrl(req.url, this.baseUrl);

    let headers = normalizeHeaders(req.headers) as Record<string, string>;

    const stealth =
      req.stealth || this.config.stealth ? { ...this.config.stealth, ...req.stealth } : undefined;

    if (stealth) {
      headers = applyStealthHeaders(headers, stealth);
    }

    const body = (req.body ?? null) as Dispatcher.DispatchOptions["body"];
    const pool = this.isExternal ? this.pool : this.getPool(parsed.origin, stealth);

    return new Promise<TransportResponse>((resolve, reject) => {
      try {
        pool.dispatch(
          {
            path: parsed.path,
            method: req.method,
            headers: headers as Dispatcher.DispatchOptions["headers"],
            body,
          },
          new UndiciDispatchHandler(resolve, reject, parsed.fullUrl, signal),
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * @ru Получает или создаёт пул соединений для указанного origin и stealth-конфигурации.
   * @en Gets or creates a connection pool for the specified origin and stealth configuration.
   * @param origin - The origin URL (scheme + host).
   * @param stealth - Optional stealth options.
   * @returns The connection pool.
   */
  private getPool(origin: string, stealth?: StealthOptions): Pool {
    const poolKey = this.buildPoolKey(origin, stealth);
    const existing = this.pools.get(poolKey);
    if (existing) return existing;

    const created = this.createNewPool(origin, stealth);
    this.pools.set(poolKey, created);
    return created;
  }

  /**
   * @ru Строит уникальный ключ для кэша пулов на основе origin и stealth-параметров.
   * @en Builds a unique key for the pool cache based on origin and stealth parameters.
   * @param origin - The origin URL.
   * @param stealth - Optional stealth options.
   * @returns The pool cache key.
   */
  private buildPoolKey(origin: string, stealth?: StealthOptions): string {
    if (!stealth) return `${origin}::default`;
    return `${origin}::${stealth.fingerprint ?? "none"}::${stealth.ciphers ?? "none"}::${stealth.fragment ?? "none"}::${stealth.http2 ? "h2" : "h1"}`;
  }

  /**
   * @ru Создаёт новый пул соединений с учётом stealth-настроек (шифры, фрагментация, HTTP/2).
   * @en Creates a new connection pool considering stealth settings (ciphers, fragmentation, HTTP/2).
   * @param origin - The origin URL.
   * @param stealth - Optional stealth options.
   * @returns The newly created pool.
   */
  private createNewPool(origin: string, stealth?: StealthOptions): Pool {
    const tlsConnectOptions: tls.ConnectionOptions = {};

    if (stealth?.ciphers) {
      tlsConnectOptions.ciphers = stealth.ciphers;
    } else if (stealth?.fingerprint) {
      tlsConnectOptions.ciphers = getCiphersForProfile(stealth.fingerprint);
    }

    const connectFactory: UndiciConnectorFn = (options, callback) => {
      let port = typeof options.port === "string" ? parseInt(options.port, 10) : options.port;
      if (!port || Number.isNaN(port)) {
        port = options.protocol === "https:" ? 443 : 80;
      }

      const host = options.host;
      if (host === undefined) {
        callback(new Error("Missing host in connect options"), null);
        return;
      }

      const socket = net.connect(port, host);
      socket.setNoDelay(true);

      if (stealth?.fragment === "split") {
        const originalWrite = socket.write as Function;
        let isFirstWrite = true;

        socket.write = function (
          this: net.Socket,
          chunk: Uint8Array | string,
          encodingOrCb?: BufferEncoding | Function,
          cb?: Function,
        ): boolean {
          let encoding: BufferEncoding | undefined;
          let callbackRef = cb;

          if (typeof encodingOrCb === "function") {
            callbackRef = encodingOrCb;
            encoding = undefined;
          } else {
            encoding = encodingOrCb;
          }

          if (
            isFirstWrite &&
            options.protocol === "https:" &&
            chunk instanceof Uint8Array &&
            chunk.length > 5
          ) {
            isFirstWrite = false;
            const splitPos = 3;
            const part1 = chunk.subarray(0, splitPos);
            const part2 = chunk.subarray(splitPos);

            originalWrite.call(this, part1, encoding, undefined);
            return originalWrite.call(this, part2, encoding, callbackRef);
          }

          return originalWrite.call(this, chunk, encoding, callbackRef);
        } as any;
      }

      socket.once("connect", () => {
        const isHttps = options.protocol === "https:";
        if (isHttps) {
          const tlsSocket = tls.connect({
            host,
            port,
            socket,
            ciphers: tlsConnectOptions.ciphers,
            servername: options.servername || host,
            ALPNProtocols: (options as any).ALPNProtocols as string[],
            rejectUnauthorized: this.config.network?.rejectUnauthorized ?? true,
          });

          tlsSocket.once("error", (err) => callback(err, null));
          tlsSocket.once("secureConnect", () => callback(null, tlsSocket));
        } else {
          callback(null, socket);
        }
      });

      socket.once("error", (err) => callback(err, null));
    };

    const isCustomConnectRequired =
      stealth?.fragment === "split" || Object.keys(tlsConnectOptions).length > 0;

    return new Pool(origin, {
      connections: this.poolOptions.connections,
      pipelining: this.poolOptions.pipelining,
      keepAliveTimeout: this.poolOptions.keepAliveTimeout,
      allowH2: stealth?.http2 ?? this.poolOptions.allowH2,
      connect: isCustomConnectRequired ? connectFactory : undefined,
    });
  }

  /**
   * @ru Мягко закрывает все пулы соединений, ожидая завершения текущих запросов.
   * @en Gracefully closes all connection pools, waiting for current requests to complete.
   * @returns Promise that resolves when all pools are closed.
   */
  public async close(): Promise<void> {
    if (this.isExternal) return;
    const promises: Promise<void>[] = [];
    if ("close" in this.pool && typeof (this.pool as Closeable).close === "function") {
      promises.push((this.pool as Closeable).close());
    }
    for (const p of this.pools.values()) promises.push(p.close());
    this.pools.clear();
    await Promise.all(promises);
  }

  /**
   * @ru Принудительно уничтожает все пулы соединений и сокеты.
   * @en Forcefully destroys all connection pools and sockets.
   * @returns Promise that resolves when all pools are destroyed.
   */
  public async destroy(): Promise<void> {
    if (this.isExternal) return;
    const promises: Promise<void>[] = [];
    if ("destroy" in this.pool && typeof (this.pool as Destroyable).destroy === "function") {
      promises.push((this.pool as Destroyable).destroy());
    }
    for (const p of this.pools.values()) promises.push(p.destroy());
    this.pools.clear();
    await Promise.all(promises);
  }
}
