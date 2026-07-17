import type { TransportStreamExtensions } from "@hyperttp/types";
import { createGunzip, createInflate, createBrotliDecompress, gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
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

function attachStreamDump(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> & TransportStreamExtensions {
  const payload = stream as ReadableStream<Uint8Array> & TransportStreamExtensions;
  payload.dump = async (): Promise<void> => {
    try {
      await payload.cancel();
    } catch {
      //
    }
  };
  return payload;
}

async function decompressOnceWeb(input: Uint8Array, encoding: string): Promise<Uint8Array> {
  const enc = encoding.trim().toLowerCase();
  if (typeof globalThis.DecompressionStream === "undefined") return input;

  const format = enc === "gzip" || enc === "x-gzip" ? "gzip" : enc === "deflate" ? "deflate" : null;
  if (!format) return input;

  const blob = new Blob([input as unknown as BlobPart]);
  const response = new Response(blob);
  const decompressedStream = response.body!.pipeThrough(
    new globalThis.DecompressionStream(format) as TransformStream<Uint8Array, Uint8Array>,
  );

  const buf = await new Response(decompressedStream).arrayBuffer();
  return new Uint8Array(buf);
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

export async function decompressBuffer(body: Uint8Array, encoding: string): Promise<Uint8Array & TransportStreamExtensions> {
  let current: Uint8Array = body;
  const encodings = parseEncodings(encoding);

  for (let i = 0; i < encodings.length; i++) {
    const enc = encodings[i]!;

    const webResult = await decompressOnceWeb(current, enc);
    if (webResult !== current) {
      current = webResult;
      continue;
    }

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

export function createDecompressStream(
  body: ReadableStream<Uint8Array>,
  encoding: string,
): ReadableStream<Uint8Array> & TransportStreamExtensions {
  const encodings = parseEncodings(encoding);
  if (encodings.length === 0) return attachStreamDump(body);

  let current: ReadableStream<Uint8Array> = body;

  for (let i = 0; i < encodings.length; i++) {
    const enc = encodings[i]!;

    const isGzip = enc === "gzip" || enc === "x-gzip";
    const isDeflate = enc === "deflate";
    const isBrotli = enc === "br";

    if ((isGzip || isDeflate) && typeof globalThis.DecompressionStream !== "undefined") {
      const format = isGzip ? "gzip" : "deflate";
      current = current.pipeThrough(
        new globalThis.DecompressionStream(format) as TransformStream<Uint8Array, Uint8Array>,
      );
    } else {
      try {
        const nodeReadable = Readable.fromWeb(current as any);
        let transformed = nodeReadable;

        if (isGzip) {
          transformed = nodeReadable.pipe(createGunzip());
        } else if (isDeflate) {
          transformed = nodeReadable.pipe(createInflate());
        } else if (isBrotli) {
          transformed = nodeReadable.pipe(createBrotliDecompress());
        }

        current = Readable.toWeb(transformed) as ReadableStream<Uint8Array>;
      } catch {
        continue;
      }
    }
  }
  return attachStreamDump(current);
}
