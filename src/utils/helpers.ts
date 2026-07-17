import type { TransportRequest } from "@hyperttp/types";
import type { PoolOptions, UndiciTransportConfig } from "../types/index.js";

/**
 * @ru Создаёт ошибку отмены операции из произвольной причины.
 * @en Creates an abort error from an arbitrary reason.
 * @param reason - The abort reason (Error, string, or other).
 * @returns An Error instance suitable for rejection.
 */
export function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new Error(reason);
  return new DOMException("The operation was aborted.", "AbortError");
}

/**
 * @ru Создаёт опции пула соединений Undici из конфигурации клиента.
 * @en Creates Undici connection pool options from client configuration.
 * @param config - Transport configuration.
 * @returns Pool options with defaults applied.
 */
export function createPoolOptions(config: UndiciTransportConfig): PoolOptions {
  const net = config.network;
  return {
    connections: net?.maxConcurrent ?? 500,
    pipelining: net?.pipelining ?? 8,
    keepAliveTimeout: net?.keepAliveTimeout ?? 30000,
    allowH2: config.stealth?.http2 ?? true,
  };
}

/**
 * @ru Быстрый парсер URL без использования `new URL()` в большинстве случаев.
 * Извлекает origin, path и полный URL для передачи в Undici dispatcher.
 * @en Fast URL parser without using `new URL()` in most cases.
 * Extracts origin, path, and full URL for Undici dispatcher.
 * @param url - The URL string to parse.
 * @param defaultBase - Default base URL for relative paths.
 * @returns Object with origin, path, and fullUrl.
 */
export function fastParseUrl(
  url: string,
  defaultBase: string,
): { origin: string; path: string; fullUrl: string } {
  const firstChar = url.charCodeAt(0);

  if (firstChar === 47) {
    // '/'
    if (url.charCodeAt(1) === 47) {
      // '//' - protocol-relative
      return fallbackParse("https:" + url, defaultBase);
    }
    const hashIdx = url.indexOf("#");
    const cleanPath = hashIdx === -1 ? url : url.slice(0, hashIdx);
    return {
      origin: defaultBase,
      path: cleanPath,
      fullUrl: defaultBase + cleanPath,
    };
  }

  const schemeIdx = url.indexOf("://");
  if (schemeIdx !== -1) {
    const start = schemeIdx + 3;
    const len = url.length;

    let pathIdx = -1;
    let qIdx = -1;
    let hashIdx = -1;
    let hasUserInfo = false;

    for (let i = start; i < len; i++) {
      const code = url.charCodeAt(i);

      if (code === 64) {
        // '@' - userinfo detected
        hasUserInfo = true;
      }
      if (code === 47) {
        // '/'
        pathIdx = i;
        break;
      }
      if (code === 63) {
        // '?'
        qIdx = i;
        break;
      }
      if (code === 35) {
        // '#'
        hashIdx = i;
        break;
      }
    }

    if (hasUserInfo) {
      return fallbackParse(url, defaultBase);
    }

    if (pathIdx !== -1) {
      hashIdx = url.indexOf("#", pathIdx);
      const origin = url.slice(0, pathIdx);
      const cleanPath = hashIdx === -1 ? url.slice(pathIdx) : url.slice(pathIdx, hashIdx);
      return { origin, path: cleanPath, fullUrl: origin + cleanPath };
    }

    if (qIdx !== -1) {
      hashIdx = url.indexOf("#", qIdx);
      const origin = url.slice(0, qIdx);
      const cleanPath = hashIdx === -1 ? "/" + url.slice(qIdx) : "/" + url.slice(qIdx, hashIdx);
      return { origin, path: cleanPath, fullUrl: origin + cleanPath };
    }

    if (hashIdx !== -1) {
      const origin = url.slice(0, hashIdx);
      return { origin, path: "/", fullUrl: origin + "/" };
    }

    return { origin: url, path: "/", fullUrl: url + "/" };
  }

  return fallbackParse(url, defaultBase);
}

/**
 * @ru Fallback-парсер URL через нативный URL API.
 * Используется для сложных случаев (userinfo, protocol-relative и т.д.).
 * @en Fallback URL parser using native URL API.
 * Used for complex cases (userinfo, protocol-relative, etc.).
 * @param url - The URL string to parse.
 * @param defaultBase - Default base URL for relative paths.
 * @returns Object with origin, path, and fullUrl.
 */
function fallbackParse(
  url: string,
  defaultBase: string,
): { origin: string; path: string; fullUrl: string } {
  try {
    const parsed = new URL(url, defaultBase);
    const cleanPath = parsed.pathname + parsed.search;
    return {
      origin: parsed.origin,
      path: cleanPath,
      fullUrl: parsed.origin + cleanPath,
    };
  } catch {
    return { origin: defaultBase, path: url, fullUrl: defaultBase + url };
  }
}

/**
 * @ru Быстрая нормализация заголовков ответа: переводит ключи в нижний регистр.
 * Значения не меняет (могут быть string | string[]).
 * @en Fast response header normalization: lowercases all keys.
 * Values are kept as-is (string | string[]).
 * @param headers - Response headers from undici.
 * @returns Normalized headers with lowercase keys.
 */
export function fastNormalizeResponseHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = Object.create(null);
  for (const key in headers) {
    out[key.toLowerCase()] = headers[key]!;
  }
  return out;
}

/**
 * @ru Нормализует заголовки, переводя все ключи в нижний регистр.
 * Поддерживает Headers, массив пар и Record.
 * Массивы значений объединяются через ", " (или "; " для cookie).
 * @en Normalizes headers by transforming all keys to lowercase.
 * Supports Headers, array of pairs, and Record.
 * Array values are joined with ", " (or "; " for cookie).
 * @param headers - The headers to normalize.
 * @returns Normalized headers object with lowercase keys.
 */
export function normalizeHeaders(headers: TransportRequest["headers"]): Record<string, string> {
  if (!headers) return Object.create(null);

  if (headers instanceof Headers) {
    const out: Record<string, string> = Object.create(null);
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = value;
    });
    return out;
  }

  if (Array.isArray(headers)) {
    const out: Record<string, string> = Object.create(null);
    for (let i = 0; i < headers.length; i++) {
      const pair = headers[i] as unknown as [string, string] | undefined;
      if (!pair) continue;
      out[pair[0].toLowerCase()] = pair[1];
    }
    return out;
  }

  const src = headers as Record<string, unknown>;

  // Быстрый path: уже lowercase, без массивов — возвращаем как есть
  let needsNormalize = false;
  for (const key in src) {
    if (key !== key.toLowerCase()) { needsNormalize = true; break; }
    const v = src[key];
    if (v == null || Array.isArray(v)) { needsNormalize = true; break; }
  }
  if (!needsNormalize) return src as Record<string, string>;

  const out: Record<string, string> = Object.create(null);
  for (const key in src) {
    const value = src[key];
    if (value == null) continue;

    const lowerKey = key.toLowerCase();
    if (Array.isArray(value)) {
      out[lowerKey] = lowerKey === "cookie" ? value.join("; ") : value.join(", ");
      continue;
    }

    out[lowerKey] = String(value);
  }

  return out;
}
