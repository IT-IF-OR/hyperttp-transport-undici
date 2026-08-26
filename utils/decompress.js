import { createGunzip, createInflate, createBrotliDecompress, gunzipSync, inflateSync, brotliDecompressSync, } from "node:zlib";
import { Readable } from "node:stream";
const NOOP_DUMP = async () => { };
function parseEncodings(encoding) {
    const result = [];
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
function attachNoopDump(buffer) {
    const payload = buffer;
    payload.dump = NOOP_DUMP;
    return payload;
}
function attachStreamDump(stream) {
    const payload = stream;
    payload.dump = async () => {
        try {
            await payload.cancel();
        }
        catch {
            //
        }
    };
    return payload;
}
async function decompressOnceWeb(input, encoding) {
    const enc = encoding.trim().toLowerCase();
    if (typeof globalThis.DecompressionStream === "undefined")
        return input;
    const format = enc === "gzip" || enc === "x-gzip" ? "gzip" : enc === "deflate" ? "deflate" : null;
    if (!format)
        return input;
    const blob = new Blob([input]);
    const response = new Response(blob);
    const decompressedStream = response.body.pipeThrough(new globalThis.DecompressionStream(format));
    const buf = await new Response(decompressedStream).arrayBuffer();
    return new Uint8Array(buf);
}
function decompressOnceNode(input, encoding) {
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
export async function decompressBuffer(body, encoding) {
    let current = body;
    const encodings = parseEncodings(encoding);
    for (let i = 0; i < encodings.length; i++) {
        const enc = encodings[i];
        const webResult = await decompressOnceWeb(current, enc);
        if (webResult !== current) {
            current = webResult;
            continue;
        }
        if (enc === "br" || enc === "gzip" || enc === "deflate" || enc === "x-gzip") {
            try {
                current = decompressOnceNode(current, enc);
            }
            catch {
                continue;
            }
        }
    }
    return attachNoopDump(current);
}
export function createDecompressStream(body, encoding) {
    const encodings = parseEncodings(encoding);
    if (encodings.length === 0)
        return attachStreamDump(body);
    let current = body;
    for (let i = 0; i < encodings.length; i++) {
        const enc = encodings[i];
        const isGzip = enc === "gzip" || enc === "x-gzip";
        const isDeflate = enc === "deflate";
        const isBrotli = enc === "br";
        if ((isGzip || isDeflate) && typeof globalThis.DecompressionStream !== "undefined") {
            const format = isGzip ? "gzip" : "deflate";
            current = current.pipeThrough(new globalThis.DecompressionStream(format));
        }
        else {
            try {
                const nodeReadable = Readable.fromWeb(current);
                let transformed = nodeReadable;
                if (isGzip) {
                    transformed = nodeReadable.pipe(createGunzip());
                }
                else if (isDeflate) {
                    transformed = nodeReadable.pipe(createInflate());
                }
                else if (isBrotli) {
                    transformed = nodeReadable.pipe(createBrotliDecompress());
                }
                current = Readable.toWeb(transformed);
            }
            catch {
                continue;
            }
        }
    }
    return attachStreamDump(current);
}
//# sourceMappingURL=decompress.js.map