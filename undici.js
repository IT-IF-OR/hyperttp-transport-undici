import net from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";
import { CacheManager } from "hcacher";
import { Dispatcher, Pool } from "undici";
import { createDecompressStream } from "./utils/decompress.js";
import { abortError, createPoolOptions, fastParseUrl, normalizeHeaders } from "./utils/helpers.js";
const DEFAULT_BASE_URL = "http://localhost:3000";
const STEALTH_HEADER_PRESETS = {
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
const STEALTH_UA_PRESETS = {
    chrome: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    firefox: "Mozilla/5.0 (X11; Linux; rv:126.0) Gecko/20100101 Firefox/126.0",
    safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    edge: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
};
function getCiphersForProfile(fingerprint) {
    if (!fingerprint)
        return "";
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
function applyStealthHeaders(headers, stealth) {
    if (!stealth?.fingerprint)
        return headers;
    const presetName = stealth.fingerprint;
    const presetHeaders = STEALTH_HEADER_PRESETS[presetName];
    if (presetHeaders) {
        for (const key in presetHeaders) {
            if (headers[key] === undefined) {
                headers[key] = presetHeaders[key];
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
function toTransportStream(body) {
    const bodyWeb = Readable.toWeb(body);
    bodyWeb.dump = async () => {
        try {
            await bodyWeb.cancel();
        }
        catch {
            // The stream may already be locked or closed.
        }
    };
    return bodyWeb;
}
export class UndiciTransport {
    protocols = ["rest"];
    config;
    pool;
    isExternal;
    pools = new Map();
    poolOptions;
    defaultOrigin;
    fastUrlCache = new Map();
    urlCacheMaxSize = 1000;
    cookieStore;
    cookieStringCache;
    responseCache;
    constructor(config) {
        this.config = config;
        this.isExternal = config.dispatcher !== undefined;
        this.poolOptions = createPoolOptions(config);
        const cookieCfg = config?.network?.cookieCache;
        this.cookieStore = new CacheManager({
            enabled: cookieCfg?.enabled ?? true,
            maxSize: cookieCfg?.maxSize ?? 256,
            ttl: cookieCfg?.ttl ?? 300_000,
            touchOnGet: true,
        });
        this.cookieStringCache = new CacheManager({
            enabled: cookieCfg?.enabled ?? true,
            maxSize: cookieCfg?.maxSize ?? 1024,
            ttl: cookieCfg?.ttl ?? 60_000,
            touchOnGet: true,
        });
        const cacheCfg = config?.network?.cache;
        if (cacheCfg?.enabled !== false && (cacheCfg?.maxSize || cacheCfg?.ttl)) {
            this.responseCache = new CacheManager({
                enabled: cacheCfg?.enabled ?? true,
                maxSize: cacheCfg?.maxSize ?? 256,
                ttl: cacheCfg?.ttl ?? 30_000,
                touchOnGet: true,
            });
        }
        else {
            this.responseCache = null;
        }
        const parsed = this.parseUrlCached(this.baseUrl);
        this.defaultOrigin = parsed.origin;
        this.pool = config.dispatcher ?? this.createNewPool(parsed.origin, config.stealth);
    }
    get baseUrl() {
        return this.config.baseUrl ?? DEFAULT_BASE_URL;
    }
    parseUrlCached(url) {
        const cached = this.fastUrlCache.get(url);
        if (cached)
            return cached;
        const parsed = fastParseUrl(url, this.baseUrl);
        if (this.fastUrlCache.size >= this.urlCacheMaxSize) {
            this.fastUrlCache.clear();
        }
        this.fastUrlCache.set(url, parsed);
        return parsed;
    }
    supports(protocol) {
        return protocol === "rest";
    }
    execute(req) {
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
        let headers;
        if (req.headers) {
            headers = normalizeHeaders(req.headers);
        }
        else {
            headers = {};
        }
        if (stealth) {
            headers = applyStealthHeaders(headers, stealth);
        }
        const body = (req.body ?? null);
        const pool = this.isExternal ? this.pool : this.getPool(parsed.origin, stealth);
        const options = {
            path: parsed.path,
            method: req.method,
            headers: headers,
            body,
            signal,
        };
        if (this.isExternal) {
            options.origin = parsed.origin;
        }
        return pool.request(options).then((response) => {
            const responseHeaders = response.headers;
            const ce = responseHeaders["content-encoding"];
            const encoding = Array.isArray(ce) ? ce[0] : ce;
            if (encoding) {
                const bodyWeb = Readable.toWeb(response.body);
                const decompressed = createDecompressStream(bodyWeb, encoding);
                const cleanedHeaders = { ...responseHeaders };
                delete cleanedHeaders["content-encoding"];
                return {
                    status: response.statusCode,
                    headers: cleanedHeaders,
                    url: parsed.fullUrl,
                    body: decompressed,
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
    rawRequest(url, method, headers, signal, body) {
        const parsed = this.parseUrlCached(url);
        const pool = this.isExternal ? this.pool : this.getPool(parsed.origin);
        const options = {
            path: parsed.path,
            method,
            headers: headers,
            body: (body ?? null),
            signal,
        };
        if (this.isExternal) {
            options.origin = parsed.origin;
        }
        return pool.request(options).then((response) => {
            return {
                status: response.statusCode,
                headers: response.headers,
                url: parsed.fullUrl,
                body: toTransportStream(response.body),
            };
        });
    }
    fastRequest(url, method, headers, signal) {
        const parsed = this.parseUrlCached(url);
        const pool = this.isExternal ? this.pool : this.getPool(parsed.origin);
        const options = {
            path: parsed.path,
            method,
            headers: headers,
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
                headers: response.headers,
                arrayBuffer: () => nodeBody.arrayBuffer(),
            };
        });
    }
    getPool(origin, stealth) {
        if (!stealth && origin === this.defaultOrigin)
            return this.pool;
        const poolKey = stealth ? this.buildPoolKey(origin, stealth) : origin;
        const existing = this.pools.get(poolKey);
        if (existing)
            return existing;
        const created = this.createNewPool(origin, stealth);
        this.pools.set(poolKey, created);
        return created;
    }
    buildPoolKey(origin, stealth) {
        return `${origin}:${stealth.fingerprint || ""}:${stealth.ciphers || ""}:${stealth.fragment || ""}:${stealth.http2 ? 1 : 0}`;
    }
    createNewPool(origin, stealth) {
        const tlsConnectOptions = {};
        if (stealth?.ciphers) {
            tlsConnectOptions.ciphers = stealth.ciphers;
        }
        else if (stealth?.fingerprint) {
            tlsConnectOptions.ciphers = getCiphersForProfile(stealth.fingerprint);
        }
        const connectFactory = (options, callback) => {
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
                const originalWrite = socket.write;
                let isFirstWrite = true;
                socket.write = function (chunk, encodingOrCb, cb) {
                    let encoding;
                    let callbackRef = cb;
                    if (typeof encodingOrCb === "function") {
                        callbackRef = encodingOrCb;
                        encoding = undefined;
                    }
                    else {
                        encoding = encodingOrCb;
                    }
                    if (isFirstWrite &&
                        options.protocol === "https:" &&
                        chunk instanceof Uint8Array &&
                        chunk.length > 5) {
                        isFirstWrite = false;
                        const splitPos = 3;
                        const part1 = chunk.subarray(0, splitPos);
                        const part2 = chunk.subarray(splitPos);
                        originalWrite.call(this, part1, encoding, undefined);
                        return originalWrite.call(this, part2, encoding, callbackRef);
                    }
                    return originalWrite.call(this, chunk, encoding, callbackRef);
                };
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
                        ALPNProtocols: options.ALPNProtocols,
                        rejectUnauthorized: this.config.network?.rejectUnauthorized ?? true,
                    });
                    tlsSocket.once("error", (err) => callback(err, null));
                    tlsSocket.once("secureConnect", () => callback(null, tlsSocket));
                }
                else {
                    callback(null, socket);
                }
            });
            socket.once("error", (err) => callback(err, null));
        };
        const isCustomConnectRequired = stealth?.fragment === "split" || Boolean(tlsConnectOptions.ciphers);
        return new Pool(origin, {
            connections: this.poolOptions.connections,
            pipelining: this.poolOptions.pipelining,
            keepAliveTimeout: this.poolOptions.keepAliveTimeout,
            allowH2: stealth?.http2 ?? this.poolOptions.allowH2,
            connect: isCustomConnectRequired ? connectFactory : undefined,
        });
    }
    async close() {
        if (this.isExternal)
            return;
        const promises = [];
        if ("close" in this.pool && typeof this.pool.close === "function") {
            promises.push(this.pool.close());
        }
        for (const p of this.pools.values())
            promises.push(p.close());
        this.pools.clear();
        this.fastUrlCache.clear();
        this.cookieStore.clear();
        this.cookieStringCache.clear();
        this.responseCache?.clear();
        await Promise.all(promises);
    }
    async destroy() {
        if (this.isExternal)
            return;
        const promises = [];
        if ("destroy" in this.pool && typeof this.pool.destroy === "function") {
            promises.push(this.pool.destroy());
        }
        for (const p of this.pools.values())
            promises.push(p.destroy());
        this.pools.clear();
        this.fastUrlCache.clear();
        this.cookieStore.clear();
        this.cookieStringCache.clear();
        this.responseCache?.clear();
        await Promise.all(promises);
    }
}
//# sourceMappingURL=undici.js.map