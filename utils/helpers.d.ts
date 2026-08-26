import type { TransportRequest } from "@hyperttp/types";
import type { PoolOptions, UndiciTransportConfig } from "../types/index.js";
export declare function abortError(reason?: unknown): Error;
export declare function createPoolOptions(config: UndiciTransportConfig): PoolOptions;
export declare function fastParseUrl(url: string, defaultBase: string): {
    origin: string;
    path: string;
    fullUrl: string;
};
export declare function fastNormalizeResponseHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]>;
export declare function normalizeHeaders(headers: TransportRequest["headers"]): Record<string, string>;
//# sourceMappingURL=helpers.d.ts.map