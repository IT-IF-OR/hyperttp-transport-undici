# @hyperttp/transport-undici

> [English](https://github.com/IT-IF-OR/hyperttp-transport-undici) | Русский

Высокопроизводительный транспорт для `@hyperttp/core` в Node.js, построенный на низкоуровневом Dispatcher API библиотеки Undici.

## Возможности

- Прямая интеграция с Undici Dispatcher API.
- Пул соединений с настройкой параллелизма, pipelining и keep-alive таймаута.
- Поддержка внешнего Undici `Dispatcher`, жизненным циклом которого управляет приложение.
- Отмена запросов через `AbortSignal`.
- Опциональные кэши ответов и cookies.
- Опциональные настройки TLS-отпечатка, HTTP/2 и фрагментации запросов.
- Контракт REST-транспорта для `@hyperttp/core@2` и `@hyperttp/types@^0.3.0`.

## Производительность

### Node.js v26.7.0 — UndiciTransport

#### Окружение

- **OS:** Linux 7.1.8-zen1-3-zen
- **CPU:** Intel(R) Core(TM) i5-8600K CPU @ 3.60GHz

#### Результаты бенчмарка

| Место | Клиент               | RPS Med | RPS Trim | Δ Best | Avg       | p50       | p90       | p99       |
| ----- | -------------------- | ------- | -------- | ------ | --------- | --------- | --------- | --------- |
| 🥇 1  | @hyperttp/core-2.0.0 | 22.38K  | 22.42K   | (ref)  | 44.44 ms  | 44.27 ms  | 47.60 ms  | 58.58 ms  |
| 🥈 2  | undici               | 22.10K  | 22.41K   | -1.3%  | 44.89 ms  | 44.64 ms  | 50.83 ms  | 60.42 ms  |
| 🥉 3  | hyperttp-0.5.0       | 19.93K  | 19.98K   | -11.0% | 50.01 ms  | 49.39 ms  | 52.98 ms  | 71.36 ms  |
| 4     | @hyperttp/core-1.5.6 | 18.55K  | 18.59K   | -17.1% | 53.62 ms  | 54.46 ms  | 61.10 ms  | 69.53 ms  |
| 5     | @hyperttp/core-1.5.5 | 17.93K  | 17.95K   | -19.9% | 55.45 ms  | 56.78 ms  | 63.41 ms  | 73.89 ms  |
| 6     | hyperttp-0.4.16      | 16.06K  | 16.00K   | -28.2% | 61.89 ms  | 63.74 ms  | 69.53 ms  | 80.35 ms  |
| 7     | bun-fetch            | 9.07K   | 9.06K    | -59.5% | 109.69 ms | 112.25 ms | 127.68 ms | 143.30 ms |

- **Лучшая медианная пропускная способность:** `@hyperttp/core-2.0.0`, 22 380 RPS.
- **Лучшая усечённая пропускная способность:** `@hyperttp/core-2.0.0`, 22 420 RPS.
- **Наибольший p99:** `bun-fetch`, 143.30 ms.

Результаты сравнивают полные клиентские стеки в одном локальном окружении и не гарантируют такую же производительность в production. Перед выбором клиента запустите тот же бенчмарк со своей нагрузкой, параллелизмом, размером данных и сетевыми условиями.

## Установка

```bash
npm install @hyperttp/core @hyperttp/transport-undici
```

```bash
bun add @hyperttp/core @hyperttp/transport-undici
```

## Использование

### С `@hyperttp/core`

```typescript
import { HyperCore } from "@hyperttp/core";
import { UndiciTransport } from "@hyperttp/transport-undici";

const transport = new UndiciTransport({
  baseUrl: "https://api.example.com",
  network: {
    maxConcurrent: 500,
    pipelining: 8,
    keepAliveTimeout: 30_000,
  },
});

const core = new HyperCore({
  customTransport: transport,
});

const response = await core.rest.get("/v1/users");
console.log(response.status, response.data);

await core.destroy();
```

Ретраи, редиректы, парсинг и другие политики запросов относятся к ядру или его плагинам, а не к конфигурации транспорта.

### Внешний dispatcher

Используйте внешний dispatcher, если приложение уже владеет Undici `Agent`, `Pool`, proxy dispatcher или другой совместимой реализацией:

```typescript
import { Pool } from "undici";
import { UndiciTransport } from "@hyperttp/transport-undici";

const pool = new Pool("https://api.example.com", {
  connections: 100,
});

const transport = new UndiciTransport({
  baseUrl: "https://api.example.com",
  dispatcher: pool,
});
```

При переданном `dispatcher` методы `transport.close()` и `transport.destroy()` не закрывают его. За жизненный цикл отвечает создавшее dispatcher приложение:

```typescript
await pool.close();
```

## Конфигурация

| Опция                        | Описание                                               |
| ---------------------------- | ------------------------------------------------------ |
| `baseUrl`                    | Базовый URL для разрешения относительных URL запросов. |
| `dispatcher`                 | Внешний Undici dispatcher.                             |
| `network.maxConcurrent`      | Максимум соединений в создаваемом пуле.                |
| `network.pipelining`         | Глубина Undici pipelining.                             |
| `network.keepAliveTimeout`   | Keep-alive таймаут в миллисекундах.                    |
| `network.rejectUnauthorized` | Проверка TLS-сертификатов.                             |
| `network.cache`              | Опциональные настройки кэша ответов.                   |
| `network.cookieCache`        | Опциональные настройки кэша cookies.                   |
| `stealth`                    | TLS-профиль, HTTP/2 и настройки фрагментации.          |

## Лицензия

MIT © dirold2
