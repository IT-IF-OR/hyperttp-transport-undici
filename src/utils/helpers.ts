import type { PoolOptions, UndiciTransportConfig } from "../types/index.js";

export function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new DOMException("The operation was aborted.", "AbortError");
}

export function createPoolOptions(config: UndiciTransportConfig): PoolOptions {
  return {
    connections: config.network?.maxConcurrent ?? 500,
    pipelining: config.network?.pipelining ?? 8,
    keepAliveTimeout: config.network?.keepAliveTimeout ?? 30000,
  };
}

/**
 * Быстрый разбор URL без лишнего `new URL()` в happy-path.
 * Возвращает origin + path/query + fullUrl.
 */
export function fastParseUrl(url: string, defaultBase: string) {
  if (url.charCodeAt(0) === 47) {
    return { origin: defaultBase, path: url, fullUrl: defaultBase + url };
  }

  const schemeIdx = url.indexOf("://");
  if (schemeIdx !== -1) {
    const start = schemeIdx + 3;

    const pathIdx = url.indexOf("/", start);
    const qIdx = url.indexOf("?", start);

    let splitIdx = -1;
    if (pathIdx !== -1) {
      splitIdx = qIdx !== -1 ? (pathIdx < qIdx ? pathIdx : qIdx) : pathIdx;
    } else {
      splitIdx = qIdx;
    }

    if (splitIdx === -1) {
      return { origin: url, path: "/", fullUrl: url + "/" };
    }

    return {
      origin: url.slice(0, splitIdx),
      path: url.slice(splitIdx),
      fullUrl: url,
    };
  }

  const parsed = new URL(url, defaultBase);
  return {
    origin: parsed.origin,
    path: parsed.pathname + parsed.search,
    fullUrl: parsed.toString(),
  };
}

function setHeader(
  bag: Record<string, string | string[]>,
  key: string,
  value: string,
): void {
  const existing = bag[key];
  if (existing === undefined) {
    bag[key] = value;
    return;
  }

  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }

  bag[key] = [existing, value];
}

export function normalizeHeaders(
  headers: unknown,
  bag: Record<string, string | string[]> = Object.create(null),
): Record<string, string | string[]> {
  if (!headers) return bag;

  if (Array.isArray(headers)) {
    for (let i = 0; i < headers.length; i += 2) {
      const key = headers[i];
      if (!key) continue;

      const rawValue = headers[i + 1];
      if (rawValue == null) continue;

      setHeader(
        bag,
        key.toLowerCase(),
        typeof rawValue === "string" ? rawValue : String(rawValue),
      );
    }
    return bag;
  }

  const src = headers as Record<string, unknown>;
  for (const key in src) {
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;

    const val = src[key];
    if (val == null) continue;

    const lower = key.toLowerCase();

    if (Array.isArray(val)) {
      bag[lower] = val.map((v) => (typeof v === "string" ? v : String(v)));
    } else {
      bag[lower] = typeof val === "string" ? val : String(val);
    }
  }

  return bag;
}
