import zlib from "node:zlib";

const EMPTY_BUFFER = Buffer.alloc(0);

function normalizeEncoding(encoding: string | undefined): string | undefined {
  if (!encoding) return undefined;

  const normalized = encoding.trim().toLowerCase();

  return normalized.length > 0 ? normalized : undefined;
}

function gunzip(buffer: Buffer): Buffer {
  return zlib.gunzipSync(buffer);
}

function inflate(buffer: Buffer): Buffer {
  return zlib.inflateSync(buffer);
}

function brotli(buffer: Buffer): Buffer {
  return zlib.brotliDecompressSync(buffer);
}

/**
 * @ru Декодирует тело ответа на основе content-encoding.
 * @en Decodes response payload using content-encoding semantics.
 */
export function decodeBodyByEncoding(
  body: Uint8Array | Buffer,
  headers: Record<string, string>,
): Buffer {
  const source =
    body instanceof Buffer
      ? body
      : Buffer.from(body.buffer, body.byteOffset, body.byteLength);

  if (source.byteLength === 0) {
    return EMPTY_BUFFER;
  }

  const encoding = normalizeEncoding(headers["content-encoding"]);

  if (!encoding || encoding === "identity") {
    return source;
  }

  try {
    if (encoding.includes("gzip")) {
      return gunzip(source);
    }

    if (encoding.includes("deflate")) {
      return inflate(source);
    }

    if (encoding.includes("br")) {
      return brotli(source);
    }

    return source;
  } catch {
    return source;
  }
}
