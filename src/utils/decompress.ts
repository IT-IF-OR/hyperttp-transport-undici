import type { TransportStreamExtensions } from "../types/index.js";
import {
  createGunzip,
  createInflate,
  createBrotliDecompress,
  gunzipSync,
  inflateSync,
  brotliDecompressSync,
} from "node:zlib";
import { Readable } from "node:stream";

const NOOP_DUMP = async (): Promise<void> => {};

function parseEncodings(encoding: string): string[] {
  const result: string[] = [];
  let start = 0;
  const len = encoding.length;

  for (let i = 0; i <= len; i++) {
    if (i === len || encoding[i] === ",") {
      const part = encoding.slice(start, i).trim().toLowerCase();
      if (part && part !== "identity") {
        result.push(part);
      }
      start = i + 1;
    }
  }

  return result;
}

function attachNoopDump(buffer: Uint8Array): Uint8Array & TransportStreamExtensions {
  const payload = buffer as Uint8Array & TransportStreamExtensions;
  payload.dump = NOOP_DUMP;
  return payload;
}

/**
 * Декомпрессия прямо на уровне Node Readable стрима.
 * Исключает пинг-понг Readable.toWeb() <-> Readable.fromWeb()
 */
export function createDecompressNodeStream(body: Readable, encoding: string): Readable {
  const encodings = parseEncodings(encoding);
  if (encodings.length === 0) return body;

  let current: Readable = body;

  for (let i = 0; i < encodings.length; i++) {
    const enc = encodings[i]!;

    if (enc === "gzip" || enc === "x-gzip") {
      current = current.pipe(createGunzip());
    } else if (enc === "deflate") {
      current = current.pipe(createInflate());
    } else if (enc === "br") {
      current = current.pipe(createBrotliDecompress());
    }
  }

  return current;
}

function decompressOnceNode(input: Uint8Array, encoding: string): Uint8Array {
  const enc = encoding.trim().toLowerCase();

  switch (enc) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(input);

    case "deflate":
      return inflateSync(input);

    case "br":
      return brotliDecompressSync(input);

    default:
      return input;
  }
}

export async function decompressBuffer(
  body: Uint8Array,
  encoding: string,
): Promise<Uint8Array & TransportStreamExtensions> {
  let current: Uint8Array = body;
  const encodings = parseEncodings(encoding);

  for (let i = 0; i < encodings.length; i++) {
    const enc = encodings[i]!;

    if (enc === "br" || enc === "gzip" || enc === "deflate" || enc === "x-gzip") {
      try {
        current = decompressOnceNode(current, enc);
      } catch {
        continue;
      }
    }
  }
  return attachNoopDump(current);
}
