import type { HyperTransport, SenderProtocol, TransportRequest, TransportResponse } from "@hyperttp/types";
import type { StealthOptions, UndiciTransportConfig } from "./types/index.js";
export declare class UndiciTransport implements HyperTransport {
    readonly protocols: readonly ["rest"];
    config: UndiciTransportConfig;
    private readonly pool;
    private readonly isExternal;
    private readonly pools;
    private readonly poolOptions;
    private readonly defaultOrigin;
    private readonly fastUrlCache;
    private readonly urlCacheMaxSize;
    private readonly cookieStore;
    private readonly cookieStringCache;
    private readonly responseCache;
    constructor(config: UndiciTransportConfig);
    private get baseUrl();
    private parseUrlCached;
    supports(protocol: SenderProtocol): boolean;
    execute(req: TransportRequest & {
        stealth?: StealthOptions;
    }): Promise<TransportResponse>;
    rawRequest(url: string, method: string, headers?: Record<string, string>, signal?: AbortSignal, body?: unknown): Promise<TransportResponse>;
    fastRequest(url: string, method: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<{
        status: number;
        headers: Record<string, string | string[]>;
        arrayBuffer: () => Promise<ArrayBuffer>;
    }>;
    private getPool;
    private buildPoolKey;
    private createNewPool;
    close(): Promise<void>;
    destroy(): Promise<void>;
}
//# sourceMappingURL=undici.d.ts.map