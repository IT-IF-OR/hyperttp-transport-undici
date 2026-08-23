# @hyperttp/transport-undici

> English | [Русский](https://github.com/IT-IF-OR/hyperttp-transport-undici/tree/main/lang/ru)

High-performance Node.js transport for `@hyperttp/core`, built on Undici's low-level Dispatcher API.

## Features

- Direct integration with the Undici Dispatcher API.
- Connection pooling with configurable concurrency, pipelining, and keep-alive timeout.
- Support for an externally managed Undici `Dispatcher`.
- Request cancellation through `AbortSignal`.
- Optional response and cookie caches.
- Optional TLS fingerprint, HTTP/2, and request-fragmentation settings.
- REST transport contract for `@hyperttp/core@2` and `@hyperttp/types@^0.3.0`.

## Performance

### Node.js v26.7.0 — UndiciTransport

#### Environment

- **OS:** Linux 7.1.8-zen1-3-zen
- **CPU:** Intel(R) Core(TM) i5-8600K CPU @ 3.60GHz

#### Benchmark results

| Rank | Client               | RPS Med | RPS Trim | Δ Best | Avg       | p50       | p90       | p99       |
| ---- | -------------------- | ------- | -------- | ------ | --------- | --------- | --------- | --------- |
| 🥇 1 | @hyperttp/core-2.0.0 | 22.38K  | 22.42K   | (ref)  | 44.44 ms  | 44.27 ms  | 47.60 ms  | 58.58 ms  |
| 🥈 2 | undici               | 22.10K  | 22.41K   | -1.3%  | 44.89 ms  | 44.64 ms  | 50.83 ms  | 60.42 ms  |
| 🥉 3 | hyperttp-0.5.0       | 19.93K  | 19.98K   | -11.0% | 50.01 ms  | 49.39 ms  | 52.98 ms  | 71.36 ms  |
| 4    | @hyperttp/core-1.5.6 | 18.55K  | 18.59K   | -17.1% | 53.62 ms  | 54.46 ms  | 61.10 ms  | 69.53 ms  |
| 5    | @hyperttp/core-1.5.5 | 17.93K  | 17.95K   | -19.9% | 55.45 ms  | 56.78 ms  | 63.41 ms  | 73.89 ms  |
| 6    | hyperttp-0.4.16      | 16.06K  | 16.00K   | -28.2% | 61.89 ms  | 63.74 ms  | 69.53 ms  | 80.35 ms  |
| 7    | bun-fetch            | 9.07K   | 9.06K    | -59.5% | 109.69 ms | 112.25 ms | 127.68 ms | 143.30 ms |

These results compare complete client stacks in one local environment; they are not a guarantee of production performance. Run the same benchmark with your workload, concurrency, payload, and network conditions before choosing a client.

## Installation

```bash
npm install @hyperttp/core @hyperttp/transport-undici
```

```bash
bun add @hyperttp/core @hyperttp/transport-undici
```

## Usage

### With `@hyperttp/core`

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

Retry, redirect, parsing, and other request policies belong to the core or its plugins rather than the transport configuration.

### External dispatcher

Use an external dispatcher when your application already owns an Undici `Agent`, `Pool`, proxy dispatcher, or another compatible implementation:

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

When `dispatcher` is supplied, `transport.close()` and `transport.destroy()` do not close it. The application that created the dispatcher remains responsible for its lifecycle:

```typescript
await pool.close();
```

## Configuration

| Option                       | Description                                      |
| ---------------------------- | ------------------------------------------------ |
| `baseUrl`                    | Base URL used to resolve relative request URLs.  |
| `dispatcher`                 | Externally managed Undici dispatcher.            |
| `network.maxConcurrent`      | Maximum connections per generated pool.          |
| `network.pipelining`         | Undici pipelining depth.                         |
| `network.keepAliveTimeout`   | Keep-alive timeout in milliseconds.              |
| `network.rejectUnauthorized` | Enables or disables TLS certificate validation.  |
| `network.cache`              | Optional response-cache settings.                |
| `network.cookieCache`        | Optional cookie-cache settings.                  |
| `stealth`                    | TLS profile, HTTP/2, and fragmentation settings. |

## License

MIT © dirold2
