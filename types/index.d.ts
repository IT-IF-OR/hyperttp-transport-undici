import type { ReadableStream } from "stream/web";
import type { Dispatcher } from "undici";
/**
 * @ru Имя отпечатка TLS-профиля, имитирующего реальный браузер.
 * @en TLS profile name emulating a specific real-world browser fingerprint.
 */
export type Fingerprint = "chrome" | "firefox" | "safari" | "edge";
/**
 * @ru Параметры скрытности: эмуляция TLS-отпечатков (JA3/JA4), подбор шифров, DPI-обход.
 * @en Stealth options: TLS fingerprint emulation (JA3/JA4), cipher selection, DPI evasion.
 */
export interface StealthOptions {
    /**
     * @ru Имя браузерного отпечатка, по которому подбираются шифры.
     * @en Browser fingerprint name used to select a cipher suite.
     */
    fingerprint?: Fingerprint;
    /**
     * @ru Явный список TLS-шифров (переопределяет подбор по отпечатку).
     * @en Explicit TLS cipher list (overrides fingerprint-based selection).
     */
    ciphers?: string;
    /**
     * @ru Включает HTTP/2 (ALPN h2) для создаваемых пулов соединений.
     * @en Enables HTTP/2 (ALPN h2) for generated connection pools.
     */
    http2?: boolean;
    /**
     * @ru Способ фрагментации запросов для обхода DPI-фильтрации.
     * @en Request fragmentation strategy to bypass DPI-based filtering.
     */
    fragment?: "split" | "none";
}
/**
 * @ru Конфигурация кэша: включение, максимальный размер и время жизни записей.
 * @en Cache configuration: enablement, maximum size and entry TTL.
 */
export interface CacheOptions {
    /**
     * @ru Флаг включения кэша.
     * @en Enables the cache.
     */
    enabled?: boolean;
    /**
     * @ru Максимальное количество записей в кэше.
     * @en Maximum number of entries stored in the cache.
     */
    maxSize?: number;
    /**
     * @ru Время жизни записей кэша в миллисекундах.
     * @en Entry time-to-live in milliseconds.
     */
    ttl?: number;
}
/**
 * @ru Дополнительные методы, навешиваемые на транспортный поток/буфер ответа.
 * @en Extra methods attached to the transport response stream/buffer.
 */
export interface TransportStreamExtensions {
    /**
     * @ru Полностью вычитывает тело ответа (сбрасывает поток в пустоту).
     * @en Fully drains the response body (discards the stream).
     */
    dump(): Promise<void>;
}
/**
 * @ru Тело ответа на транспортном уровне: сырой стрим или буфер байтов.
 * @en Transport-level response payload: a raw stream or byte buffer.
 */
export type TransportResponsePayload = (ReadableStream<Uint8Array> & TransportStreamExtensions) | (Uint8Array & TransportStreamExtensions) | null;
/**
 * @ru Внутренний атомарный результат низкоуровневой диспетчеризации запроса.
 * @en Internal atomic result produced by the low-level network dispatch driver.
 */
export type DispatchResult = {
    /**
     * @ru HTTP статус-код ответа сервера.
     * @en HTTP numeric status code returned by the remote origin.
     */
    status: number;
    /**
     * @ru Нормализованные заголовки ответа.
     * @en Normalized dictionary representation containing response headers.
     */
    headers: Record<string, string>;
    /**
     * @ru Сырой буфер бинарных данных тела ответа.
     * @en Raw binary buffer containing the fully aggregated response payload.
     */
    body: ReadableStream<Uint8Array>;
    /**
     * @ru Финальный абсолютный URL (с учетом возможных редиректов).
     * @en Absolute target URL pointing to where the response was ultimately extracted from.
     */
    url: string;
};
export interface PoolOptions {
    connections: number;
    pipelining: number;
    keepAliveTimeout: number;
    allowH2: boolean;
}
/**
 * @ru Конфигурация транспорта на базе Undici с поддержкой stealth-сессий.
 * @en Undici-based transport configuration with integrated stealth session support.
 */
export interface UndiciTransportConfig {
    baseUrl?: string;
    dispatcher?: Dispatcher;
    /**
     * @ru Глобальный профиль маскировки для всех создаваемых пулов соединений.
     * @en Global stealth profile applied to all generated connection pools.
     */
    stealth?: StealthOptions;
    network?: {
        maxConcurrent?: number;
        pipelining?: number;
        keepAliveTimeout?: number;
        /**
         * @ru Проброс флага валидации SSL для консистентности TLS-стека.
         * @en SSL validation flag forwarding for TLS stack consistency.
         */
        rejectUnauthorized?: boolean;
        /**
         * @ru Конфигурация кэша HTTP-ответов.
         * @en HTTP response cache configuration.
         */
        cache?: CacheOptions;
        /**
         * @ru Конфигурация кэша cookies.
         * @en Cookie cache configuration.
         */
        cookieCache?: CacheOptions;
    };
}
//# sourceMappingURL=index.d.ts.map