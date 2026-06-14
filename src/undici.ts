import { Pool, Dispatcher } from "undici";
import type {
  HyperTransport,
  TransportRequest,
  TransportResponse,
  TransportResponsePayload,
} from "@hyperttp/types";
import { abortError, createPoolOptions, fastParseUrl, normalizeHeaders } from "./utils/helpers.js";
import type { PoolOptions, UndiciTransportConfig } from "./types/index.js";
import type { TransportStreamExtensions } from "@hyperttp/types";
import { createDecompressStream } from "./utils/decompress.js";

const DEFAULT_BASE_URL = "http://localhost:3000";
const FALLBACK_ORIGIN = "http://localhost";

export class UndiciDispatchHandler implements Dispatcher.DispatchHandler {
  private undiciController: Dispatcher.DispatchController | null = null;
  private streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private onAbortRef?: () => void;
  private isResolved = false;
  private finished = false;

  constructor(
    private readonly resolve: (value: TransportResponse) => void,
    private readonly reject: (reason: Error) => void,
    private readonly url: string,
    private readonly signal?: AbortSignal,
  ) {}

  onRequestStart(controller: Dispatcher.DispatchController): void {
    this.undiciController = controller;

    const signal = this.signal;
    if (!signal) return;

    if (signal.aborted) {
      controller.abort(abortError(signal.reason));
      return;
    }

    this.onAbortRef = () => {
      const err = abortError(signal.reason);
      controller.abort(err);

      const stream = this.streamController;
      if (stream) {
        try {
          stream.error(err);
        } catch {}
      }
    };

    signal.addEventListener("abort", this.onAbortRef, { once: true });
  }

  private readonly dumpBody = async (): Promise<void> => {
    this.cleanup();

    const controller = this.undiciController;
    if (controller) {
      controller.abort(new Error("Stream dumped"));
    }

    const streamCtrl = this.streamController;
    if (streamCtrl && !this.finished) {
      this.finished = true;
      try {
        streamCtrl.close();
      } catch {}
    }

    this.release();
  };

  onResponseStart(
    _controller: Dispatcher.DispatchController,
    statusCode: number,
    headers: unknown,
  ): void {
    this.isResolved = true;
    const normalizedHeaders = normalizeHeaders(headers);

    const rawStream = new ReadableStream<Uint8Array>({
      start: (ctrl) => {
        this.streamController = ctrl;
        const signal = this.signal;
        if (signal?.aborted) {
          const err = abortError(signal.reason);
          try {
            ctrl.error(err);
          } catch {}
        }
      },
      cancel: (reason) => {
        this.cleanup();
        const controller = this.undiciController;
        if (controller) {
          controller.abort(reason instanceof Error ? reason : abortError(reason));
        }
        this.release();
      },
    });

    const ce = normalizedHeaders["content-encoding"] || normalizedHeaders["Content-Encoding"];
    const encoding = Array.isArray(ce) ? ce[0] : ce;

    if (encoding) {
      createDecompressStream(rawStream, encoding)
        .then((decompressedStream) => {
          delete normalizedHeaders["content-encoding"];
          delete normalizedHeaders["Content-Encoding"];

          this.resolve({
            status: statusCode,
            headers: normalizedHeaders,
            url: this.url,
            body: decompressedStream as unknown as TransportResponsePayload,
          });
        })
        .catch((err) => {
          if (this.streamController) {
            try {
              this.streamController.error(err);
            } catch {}
          }
          this.reject(err);
        });
    } else {
      const payload = rawStream as ReadableStream<Uint8Array> & TransportStreamExtensions;
      payload.dump = this.dumpBody;

      this.resolve({
        status: statusCode,
        headers: normalizedHeaders,
        url: this.url,
        body: payload as unknown as TransportResponsePayload,
      });
    }
  }

  onResponseData(_controller: Dispatcher.DispatchController, chunk: Buffer): boolean {
    if (this.signal?.aborted) return false;

    const ctrl = this.streamController;
    if (!ctrl) return true;

    try {
      ctrl.enqueue(chunk);
      return true;
    } catch {
      return false;
    }
  }

  onResponseEnd(): void {
    if (this.finished) return;
    this.finished = true;

    this.cleanup();

    const ctrl = this.streamController;
    if (ctrl) {
      try {
        ctrl.close();
      } catch {}
    }

    this.release();
  }

  onResponseError(_controller: Dispatcher.DispatchController, error: Error): void {
    if (this.finished) return;
    this.finished = true;

    this.cleanup();

    if (!this.isResolved) {
      this.reject(error);
      this.release();
      return;
    }

    const ctrl = this.streamController;
    if (ctrl) {
      try {
        ctrl.error(error);
      } catch {}
    }

    this.release();
  }

  private cleanup(): void {
    const signal = this.signal;
    const abortRef = this.onAbortRef;

    if (signal && abortRef) {
      signal.removeEventListener("abort", abortRef);
    }

    this.onAbortRef = undefined;
  }

  private release(): void {
    this.undiciController = null;
    this.streamController = null;
    this.onAbortRef = undefined;
  }
}

export class UndiciTransport implements HyperTransport {
  public config: UndiciTransportConfig;
  private readonly pool: Dispatcher;
  private readonly isExternal: boolean;
  private readonly pools = new Map<string, Pool>();
  private readonly poolOptions: PoolOptions;

  constructor(config: UndiciTransportConfig) {
    this.config = config;
    this.isExternal = config.dispatcher !== undefined;
    this.poolOptions = createPoolOptions(config);

    const parsed = fastParseUrl(this.baseUrl, FALLBACK_ORIGIN);

    this.pool =
      config.dispatcher ??
      new Pool(parsed.origin, {
        connections: this.poolOptions.connections,
        pipelining: this.poolOptions.pipelining,
        keepAliveTimeout: this.poolOptions.keepAliveTimeout,
      });
  }

  private get baseUrl(): string {
    return this.config.baseUrl ?? DEFAULT_BASE_URL;
  }

  public async execute(req: TransportRequest): Promise<TransportResponse> {
    const signal = req.signal;
    if (signal?.aborted) {
      throw abortError(signal.reason);
    }

    const parsed = fastParseUrl(req.url, this.baseUrl);
    const body = (req.body ?? null) as Dispatcher.DispatchOptions["body"];
    const pool = this.isExternal ? this.pool : this.getPool(parsed.origin);

    return new Promise<TransportResponse>((resolve, reject) => {
      try {
        pool.dispatch(
          {
            path: parsed.path,
            method: req.method,
            headers: req.headers as Dispatcher.DispatchOptions["headers"],
            body,
          },
          new UndiciDispatchHandler(resolve, reject, parsed.fullUrl, signal),
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private getPool(origin: string): Pool {
    const existing = this.pools.get(origin);
    if (existing) return existing;

    const created = new Pool(origin, {
      connections: this.poolOptions.connections,
      pipelining: this.poolOptions.pipelining,
      keepAliveTimeout: this.poolOptions.keepAliveTimeout,
    });

    this.pools.set(origin, created);
    return created;
  }

  public async close(): Promise<void> {
    if (this.isExternal) return;

    const promises: Promise<void>[] = [this.pool.close()];
    for (const p of this.pools.values()) promises.push(p.close());

    this.pools.clear();
    await Promise.all(promises);
  }

  public async destroy(): Promise<void> {
    if (this.isExternal) return;

    const promises: Promise<void>[] = [this.pool.destroy()];
    for (const p of this.pools.values()) promises.push(p.destroy());

    this.pools.clear();
    await Promise.all(promises);
  }
}
