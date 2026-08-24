import net from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";
import type {
  HyperTransport,
  SenderProtocol,
  TransportRequest,
  TransportResponse,
} from "@hyperttp/types";
import { CacheManager } from "hcacher";
import { Dispatcher, Pool } from "undici";

import type {
  Fingerprint,
  PoolOptions,
  StealthOptions,
  TransportResponsePayload,
  TransportStreamExtensions,
  UndiciTransportConfig,
} from "./types/index.js";

import { createDecompressStream } from "./utils/decompress.js";
import { abortError, createPoolOptions, fastParseUrl, normalizeHeaders } from "./utils/helpers.js";

const DEFAULT_BASE_URL = "http://localhost:3000";

type UndiciPoolOptions = NonNullable<ConstructorParameters<typeof Pool>[1]>;
type UndiciConnectorFn = Extract<NonNullable<UndiciPoolOptions["connect"]>, Function>;

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

const STEALTH_UA_PRESETS: Record<string, string> = {
  chrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  firefox: "Mozilla/5.0 (X11; Linux; rv:126.0) Gecko/20100101 Firefox/126.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  edge: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
};

function getCiphersForProfile(fingerprint: Fingerprint | undefined): string {
  if (!fingerprint) return "";
  switch (fingerprint) {
    case "chrome":
    case "edge":
      return "TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256";
    case "firefox":
      return "TLS_AES_128_GCM_SHA256:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256";
    case "safari":
      return "TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384";
    default:
      return "";
  }
}

function applyStealthHeaders(
  headers: Record<string, string>,
  stealth: StealthOptions,
): Record<string, string> {
  if (!stealth?.fingerprint) return headers;

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

function toTransportStream(
  body: Readable,
): ReadableStream<Uint8Array> & TransportStreamExtensions {
  const bodyWeb = Readable.toWeb(body) as ReadableStream<Uint8Array> & TransportStreamExtensions;
  bodyWeb.dump = async (): Promise<void> => {
    try {
      await bodyWeb.cancel();
    } catch {
      // The stream may already be locked or closed.
    }
  };
  return bodyWeb;
}

export class UndiciTransport implements HyperTransport {
  public readonly protocols = ["rest"] as const;
  public config: UndiciTransportConfig;
  private readonly pool: Dispatcher;
  private readonly isExternal: boolean;
  private readonly pools = new Map<string, Pool>();
  private readonly poolOptions: PoolOptions;
  private readonly defaultOrigin: string;

  private readonly fastUrlCache = new Map<
    string,
    { origin: string; path: string; fullUrl: string }
  >();
  private readonly urlCacheMaxSize = 1000;

  private readonly cookieStore: CacheManager<Record<string, string>>;
  private readonly cookieStringCache: CacheManager<string>;
  private readonly responseCache: CacheManager<TransportResponse> | null;

  constructor(config: UndiciTransportConfig) {
    this.config = config;
    this.isExternal = config.dispatcher !== undefined;
    this.poolOptions = createPoolOptions(config);

    const cookieCfg = config?.network?.cookieCache;
    this.cookieStore = new CacheManager<Record<string, string>>({
      enabled: cookieCfg?.enabled ?? true,
      maxSize: cookieCfg?.maxSize ?? 256,
      ttl: cookieCfg?.ttl ?? 300_000,
      touchOnGet: true,
    });

    this.cookieStringCache = new CacheManager<string>({
      enabled: cookieCfg?.enabled ?? true,
      maxSize: cookieCfg?.maxSize ?? 1024,
      ttl: cookieCfg?.ttl ?? 60_000,
      touchOnGet: true,
    });

    const cacheCfg = config?.network?.cache;
    if (cacheCfg?.enabled !== false && (cacheCfg?.maxSize || cacheCfg?.ttl)) {
      this.responseCache = new CacheManager<TransportResponse>({
        enabled: cacheCfg?.enabled ?? true,
        maxSize: cacheCfg?.maxSize ?? 256,
        ttl: cacheCfg?.ttl ?? 30_000,
        touchOnGet: true,
      });
    } else {
      this.responseCache = null;
    }

    const parsed = this.parseUrlCached(this.baseUrl);
    this.defaultOrigin = parsed.origin;
    this.pool = config.dispatcher ?? this.createNewPool(parsed.origin, config.stealth);
  }

  private get baseUrl(): string {
    return this.config.baseUrl ?? DEFAULT_BASE_URL;
  }

  private parseUrlCached(url: string): {
    origin: string;
    path: string;
    fullUrl: string;
  } {
    const cached = this.fastUrlCache.get(url);
    if (cached) return cached;

    const parsed = fastParseUrl(url, this.baseUrl);
    if (this.fastUrlCache.size >= this.urlCacheMaxSize) {
      this.fastUrlCache.clear();
    }
    this.fastUrlCache.set(url, parsed);
    return parsed;
  }

  public supports(protocol: SenderProtocol): boolean {
    return protocol === "rest";
  }

  public execute(req: TransportRequest & { stealth?: StealthOptions }): Promise<TransportResponse> {
    const signal = req.signal;
    if (signal?.aborted) {
      return Promise.reject(abortError(signal.reason));
    }

    const parsed = this.parseUrlCached(req.url);

    const configStealth = this.config.stealth;
    const reqStealth = req.stealth;
    const stealth = reqStealth
      ? configStealth
        ? { ...configStealth, ...reqStealth }
        : reqStealth
      : configStealth;

    let headers: Record<string, string>;
    if (req.headers) {
      headers = normalizeHeaders(req.headers);
    } else {
      headers = {};
    }

    if (stealth) {
      headers = applyStealthHeaders(headers, stealth);
    }

    const body = (req.body ?? null) as Dispatcher.DispatchOptions["body"];
    const pool = this.isExternal ? this.pool : this.getPool(parsed.origin, stealth);

    const options: Dispatcher.RequestOptions = {
      path: parsed.path,
      method: req.method,
      headers: headers as Dispatcher.DispatchOptions["headers"],
      body,
      signal,
    };
    if (this.isExternal) {
      options.origin = parsed.origin;
    }

    return pool.request(options).then((response) => {
      const responseHeaders = response.headers as Record<string, string | string[]>;
      const ce = responseHeaders["content-encoding"];
      const encoding = Array.isArray(ce) ? ce[0] : ce;

      if (encoding) {
        const bodyWeb = Readable.toWeb(response.body) as ReadableStream<Uint8Array>;
        const decompressed = createDecompressStream(bodyWeb, encoding);

        const cleanedHeaders = { ...responseHeaders };
        delete cleanedHeaders["content-encoding"];

        return {
          status: response.statusCode,
          headers: cleanedHeaders,
          url: parsed.fullUrl,
          body: decompressed as TransportResponsePayload,
        };
      }

      return {
        status: response.statusCode,
        headers: responseHeaders,
        url: parsed.fullUrl,
        body: toTransportStream(response.body),
      };
    });
  }

  public rawRequest(
    url: string,
    method: string,
    headers?: Record<string, string>,
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<TransportResponse> {
    const parsed = this.parseUrlCached(url);
    const pool = this.isExternal ? this.pool : this.getPool(parsed.origin);

    const options: Dispatcher.RequestOptions = {
      path: parsed.path,
      method,
      headers: headers as Dispatcher.DispatchOptions["headers"],
      body: (body ?? null) as Dispatcher.DispatchOptions["body"],
      signal,
    };
    if (this.isExternal) {
      options.origin = parsed.origin;
    }

    return pool.request(options).then((response) => {
      return {
        status: response.statusCode,
        headers: response.headers as Record<string, string | string[]>,
        url: parsed.fullUrl,
        body: toTransportStream(response.body),
      };
    });
  }

  public fastRequest(
    url: string,
    method: string,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{
    status: number;
    headers: Record<string, string | string[]>;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }> {
    const parsed = this.parseUrlCached(url);
    const pool = this.isExternal ? this.pool : this.getPool(parsed.origin);

    const options: Dispatcher.RequestOptions = {
      path: parsed.path,
      method,
      headers: headers as Dispatcher.DispatchOptions["headers"],
      body: null,
      signal,
    };
    if (this.isExternal) {
      options.origin = parsed.origin;
    }

    return pool.request(options).then((response) => {
      const nodeBody = response.body;
      return {
        status: response.statusCode,
        headers: response.headers as Record<string, string | string[]>,
        arrayBuffer: () => nodeBody.arrayBuffer(),
      };
    });
  }

  private getPool(origin: string, stealth?: StealthOptions): Pool {
    if (!stealth && origin === this.defaultOrigin) return this.pool as Pool;
    const poolKey = stealth ? this.buildPoolKey(origin, stealth) : origin;
    const existing = this.pools.get(poolKey);
    if (existing) return existing;

    const created = this.createNewPool(origin, stealth);
    this.pools.set(poolKey, created);
    return created;
  }

  private buildPoolKey(origin: string, stealth: StealthOptions): string {
    return `${origin}:${stealth.fingerprint || ""}:${stealth.ciphers || ""}:${stealth.fragment || ""}:${stealth.http2 ? 1 : 0}`;
  }

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
      stealth?.fragment === "split" || Boolean(tlsConnectOptions.ciphers);

    return new Pool(origin, {
      connections: this.poolOptions.connections,
      pipelining: this.poolOptions.pipelining,
      keepAliveTimeout: this.poolOptions.keepAliveTimeout,
      allowH2: stealth?.http2 ?? this.poolOptions.allowH2,
      connect: isCustomConnectRequired ? connectFactory : undefined,
    });
  }

  public async close(): Promise<void> {
    if (this.isExternal) return;
    const promises: Promise<void>[] = [];
    if ("close" in this.pool && typeof (this.pool as any).close === "function") {
      promises.push((this.pool as any).close());
    }
    for (const p of this.pools.values()) promises.push(p.close());
    this.pools.clear();
    this.fastUrlCache.clear();
    this.cookieStore.clear();
    this.cookieStringCache.clear();
    this.responseCache?.clear();
    await Promise.all(promises);
  }

  public async destroy(): Promise<void> {
    if (this.isExternal) return;
    const promises: Promise<void>[] = [];
    if ("destroy" in this.pool && typeof (this.pool as any).destroy === "function") {
      promises.push((this.pool as any).destroy());
    }
    for (const p of this.pools.values()) promises.push(p.destroy());
    this.pools.clear();
    this.fastUrlCache.clear();
    this.cookieStore.clear();
    this.cookieStringCache.clear();
    this.responseCache?.clear();
    await Promise.all(promises);
  }
}
