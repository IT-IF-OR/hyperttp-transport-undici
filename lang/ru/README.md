# @hyperttp/transport-undici

Высокопроизводительный сетевой транспорт для HTTP-клиента `hyperttp`,
построенный на базе низкоуровневого API **Undici Dispatch**.
Спроектирован специально для Node.js сред с экстремальными требованиями к пропускной способности (RPS) и
минимальным задержкам (Latency).

## ✨ Особенности

- **Undici Dispatch API**: Минует накладные расходы стандартного `fetch` и стримов Node.js,
  собирая буферы чанков напрямую через низкоуровневые события пула.
- **Сверхстабильный p99**: Благодаря оптимизированному управлению жизненным циклом `AbortSignal` и
  минимизации аллокаций в замыканиях, транспорт снижает нагрузку на Garbage Collector (GC).
- **Нативная интеграция политик**: Автоматическая сквозная поддержка ретраев (Retry Policy),
  умного следования редиректам (Redirect Policy) и кастомных таймаутов ядра `hyperttp`.
- **Безопасный Event Loop**: Логика отмены изолирована и не порождает `Unhandled Rejection` или
  зависшие макротаски таймеров при обрыве соединений.

## 📊 Производительность (Node.js v24)

Результаты бенчмарка при обработке **20,000 запросов** (Concurrency: 200) на локальном JSON-эндпоинте:

| Клиент                                        | Throughput (RPS) | Latency Avg | p50        | p99         | Peak Heap   |
| :-------------------------------------------- | :--------------- | :---------- | :--------- | :---------- | :---------- |
| **@hyperttp/core (with Undici Transport)** 🚀 | **22.48K rps**   | **8.81ms**  | **7.47ms** | **21.10ms** | **49.8 MB** |
| Чистый `undici`                               | 17.50K rps       | 11.36ms     | 10.31ms    | 39.45ms     | 68.0 MB     |
| `axios`                                       | 5.47K rps        | 36.35ms     | 34.61ms    | 62.03ms     | 125.0 MB    |

## 📦 Установка

Поскольку этот транспорт является опциональным, установите его в свой проект вручную:

```bash
bun add @hyperttp/transport-undici
# или
npm install @hyperttp/transport-undici

```

## 🚀 Использование

### Базовая инициализация с ядром

```typescript
import { HyperClient } from "@hyperttp/core";
import { UndiciTransport } from "@hyperttp/transport-transport-undici";

const client = new HyperClient({
  baseUrl: "https://api.example.com",
  transport: new UndiciTransport({
    network: {
      maxConcurrent: 500, // Максимальное количество параллельных сокетов
      pipelining: 8, // Глубина конвейеризации запросов в сокете
      keepAliveTimeout: 30000, // Таймаут удержания сокета в ms
    },
    retry: {
      maxRetries: 3,
      retryStatuses: [502, 503, 504],
    },
  }),
});

const response = await client.request({
  url: "/v1/users",
  method: "GET",
});

const users = await response.json();
```

### Использование внешнего (кастомного) диспетчера

Если в вашем приложении уже настроен глобальный агент или пул `undici` (например, для проксирования или работы через Unix-сокет),
вы можете пробросить его напрямую:

```typescript
import { Pool } from "undici";
import { UndiciTransport } from "@hyperttp/transport-undici";

const customPool = new Pool("http://localhost:3000", {
  connections: 100,
  connect: { rejectUnauthorized: false },
});

const transport = new UndiciTransport({
  dispatcher: customPool, // Использовать существующий экземпляр
});
```

> ⚠️ **Примечание:** Если `dispatcher` передан извне, вызовы `transport.close()` и
> `transport.destroy()` внутри `hyperttp` будут игнорироваться, чтобы не нарушать работу внешнего контекста.
> Разрушение пула остается на стороне вашей архитектуры.

## 🛠 Архитектура отмены и таймаутов

Транспорт использует атомарный хелпер `combineSignal`,
объединяющий внешний `AbortSignal` пользователя и внутренний таймер ограничения операции:

1. На уровне **Dispatch Handler**: При возникновении события передачи данных `onResponseData`,
   если сигнал отмены уже взведен, сокет немедленно терминируется вызовом `controller.abort()`.
2. На уровне **Error Policy**:
   Ошибки таймаута заголовков (`UND_ERR_HEADERS_TIMEOUT`) и тела (`UND_ERR_BODY_TIMEOUT`) приводятся к стандартному типу
   `AbortError` с сохранением исходного `cause` для отладки.

## 📄 Лицензия

MIT
