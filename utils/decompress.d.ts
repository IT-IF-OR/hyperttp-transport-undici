import type { TransportStreamExtensions } from "../types/index.js";
export declare function decompressBuffer(body: Uint8Array, encoding: string): Promise<Uint8Array & TransportStreamExtensions>;
export declare function createDecompressStream(body: ReadableStream<Uint8Array>, encoding: string): ReadableStream<Uint8Array> & TransportStreamExtensions;
//# sourceMappingURL=decompress.d.ts.map