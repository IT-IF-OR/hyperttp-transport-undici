import type { TransportStreamExtensions } from "../types/index.js";
import { Readable } from "node:stream";
/**
 * Декомпрессия прямо на уровне Node Readable стрима.
 * Исключает пинг-понг Readable.toWeb() <-> Readable.fromWeb()
 */
export declare function createDecompressNodeStream(body: Readable, encoding: string): Readable;
export declare function decompressBuffer(body: Uint8Array, encoding: string): Promise<Uint8Array & TransportStreamExtensions>;
//# sourceMappingURL=decompress.d.ts.map