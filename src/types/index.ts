import type { HttpClientOptions, RetryOptions, StealthOptions } from "@hyperttp/types";
import type { ReadableStream } from "stream/web";
import type { Dispatcher } from "undici";

/**
 * @ru Конфигурация сетевого транспорта, расширяющая базовые опции клиента.
 * @en Transport layer configuration expanding the core HTTP client options.
 */
export interface TransportConfig extends HttpClientOptions {
  /**
   * @ru Опции политики повторных запросов (ретраев).
   * @en Retry policy behavior and strategy configurations.
   */
  retry?: RetryOptions;

  /**
   * @ru Параметры скрытности, эмуляции отпечатков TLS (JA3/JA4) и обхода систем DPI.
   * @en Stealth options for TLS fingerprint emulation and DPI evasion strategies.
   */
  stealth?: StealthOptions;

  /**
   * @ru Низкоуровневые параметры тюнинга сетевых соединений сокетов.
   * @en Low-level parameters optimized for underlying network socket connection tuning.
   */
  network?: {
    /**
     * @ru Максимальное количество параллельно открытых сокетов в пуле.
     * @en Maximum concurrent open sockets allocated within the connection pool.
     */
    maxConcurrent?: number;

    /**
     * @ru Глубина конвейеризации HTTP-запросов (pipelining) внутри одного сокета.
     * @en HTTP pipelining factor specifying the maximum pending requests per single socket.
     */
    pipelining?: number;

    /**
     * @ru Время удержания простаивающего сокета в миллисекундах (Keep-Alive).
     * @en Inactivity timeout in milliseconds keeping idle pool sockets alive.
     */
    keepAliveTimeout?: number;

    /**
     * @ru Предельное время ожидания ответа на запрос (таймаут операции) в миллисекундах.
     * @en High-level timeout threshold in milliseconds covering the entire lifecycle of a request.
     */
    timeout?: number;

    /**
     * @ru Флаг автоматического следования HTTP-редиректам (3xx коды).
     * @en Determines whether the engine should transparently follow HTTP redirect signatures (3xx).
     */
    followRedirects?: boolean;

    /**
     * @ru Максимально допустимое количество последовательных перенаправлений.
     * @en Boundary limit protecting execution context from infinite redirect cycles.
     */
    maxRedirects?: number;

    /**
     * @ru Проверка валидности SSL/TLS сертификатов удаленного сервера.
     * @en Determines whether to verify the remote host's SSL/TLS certificate integrity chain.
     */
    rejectUnauthorized?: boolean;
  };
}

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
  };
}
