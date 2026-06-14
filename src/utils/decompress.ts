import type { TransportStreamExtensions } from "@hyperttp/types";

type StreamPayload = ReadableStream<Uint8Array> & TransportStreamExtensions;
type BufferPayload = Uint8Array & TransportStreamExtensions;

interface NodeReadableLike {
  pipe<T extends NodeReadableLike>(writableStream: unknown): T;
}

interface NodeStreamModule {
  Readable: {
    fromWeb(stream: unknown, options?: unknown): NodeReadableLike;
    toWeb(nodeStream: unknown): ReadableStream<Uint8Array>;
  };
}

interface NodeZlibModule {
  gunzipSync(buf: Uint8Array): Uint8Array;
  inflateSync(buf: Uint8Array): Uint8Array;
  brotliDecompressSync(buf: Uint8Array): Uint8Array;
  createGunzip(): unknown;
  createInflate(): unknown;
  createBrotliDecompress(): unknown;
}

const NOOP_DUMP = async (): Promise<void> => {};

let zlibModulePromise: Promise<NodeZlibModule> | null = null;
let streamModulePromise: Promise<NodeStreamModule> | null = null;

async function getZlibModule(): Promise<NodeZlibModule> {
  if (!zlibModulePromise) {
    // Используем нативный ESM импорт, так как в Node/Bun он работает из коробки
    zlibModulePromise = import("node:zlib") as unknown as Promise<NodeZlibModule>;
  }
  return zlibModulePromise;
}

async function getStreamModule(): Promise<NodeStreamModule> {
  if (!streamModulePromise) {
    streamModulePromise = import("node:stream") as unknown as Promise<NodeStreamModule>;
  }
  return streamModulePromise;
}

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

function attachNoopDump(buffer: Uint8Array): BufferPayload {
  const payload = buffer as BufferPayload;
  payload.dump = NOOP_DUMP;
  return payload;
}

function attachStreamDump(stream: ReadableStream<Uint8Array>): StreamPayload {
  const payload = stream as StreamPayload;
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

async function decompressOnceNode(input: Uint8Array, encoding: string): Promise<Uint8Array> {
  const enc = encoding.trim().toLowerCase();
  const zlib = await getZlibModule();

  switch (enc) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(input);
    case "deflate":
      return zlib.inflateSync(input);
    case "br":
      return zlib.brotliDecompressSync(input);
    default:
      return input;
  }
}

export async function decompressBuffer(body: Uint8Array, encoding: string): Promise<BufferPayload> {
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
        current = await decompressOnceNode(current, enc);
      } catch {
        continue;
      }
    }
  }
  return attachNoopDump(current);
}

export async function createDecompressStream(
  body: ReadableStream<Uint8Array>,
  encoding: string,
): Promise<StreamPayload> {
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
        const streamMod = await getStreamModule();
        const zlibMod = await getZlibModule();

        const nodeReadableStream = streamMod.Readable.fromWeb(current);
        let transformer: NodeReadableLike = nodeReadableStream;

        if (isGzip) {
          transformer = nodeReadableStream.pipe<NodeReadableLike>(zlibMod.createGunzip());
        } else if (isDeflate) {
          transformer = nodeReadableStream.pipe<NodeReadableLike>(zlibMod.createInflate());
        } else if (isBrotli) {
          transformer = nodeReadableStream.pipe<NodeReadableLike>(zlibMod.createBrotliDecompress());
        }

        current = streamMod.Readable.toWeb(transformer);
      } catch {
        continue;
      }
    }
  }
  return attachStreamDump(current);
}
