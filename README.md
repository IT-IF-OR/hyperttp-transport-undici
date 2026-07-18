# @hyperttp/transport-undici

A high-performance network transport layer for the `hyperttp` HTTP client, built directly on top of the low-level
**Undici Dispatch API**. Engineered specifically for Node.js environments with extreme throughput (RPS) requirements and
ultra-low latency demands.

## ✨ Features

- **Undici Dispatch API**: Bypasses the overhead of the standard `fetch` API and Node.js streams by
  collecting chunk buffers directly via low-level pool lifecycle events.
- **Ultra-Stable p99 Latency**: Drastically reduces Garbage Collector (GC) pressure by optimizing `AbortSignal`
  lifecycle management and minimizing closure allocations per request.
- **Native Policy Integration**: End-to-end,
  out-of-the-box support for `hyperttp` core mechanisms including Retry Policies,
  smart Redirect Policies, and custom network timeouts.
- **Safe Event Loop**:
  Isolated abort logic guarantees that connection teardowns never yield unhandled promise rejections or dangling timer macro-tasks.

## 📊 Performance (Node.js v24)

Benchmark: **20,000 requests** · Concurrency: **200** · Duration: **60s** · Target: local JSON endpoint

### Node.js v24.16.0 — UndiciTransport

- **OS:** linux 7.1.3-zen2-1-zen
- **CPU:** Intel(R) Core(TM) i5-8600K CPU @ 3.60GHz

| Rank | Client         |    RPS |      Avg |      p50 |      p90 |      p99 | Errors |
| :--: | :------------- | -----: | -------: | -------: | -------: | -------: | -----: |
| 🥇 1 | undici         | 15.98K | 12.47 ms | 12.08 ms | 14.17 ms | 18.80 ms |      0 |
| 🥈 2 | @hyperttp/core | 13.08K | 15.11 ms | 13.98 ms | 17.03 ms | 23.32 ms |      0 |
| 🥉 3 | bun-fetch      |  8.56K | 23.25 ms | 21.78 ms | 29.81 ms | 34.75 ms |      0 |
| 4    | axios          |  4.74K | 42.08 ms | 40.66 ms | 46.62 ms | 56.00 ms |      0 |

## 📦 Installation

Since this transport is optional, you need to add it to your project manually:

```bash
bun add @hyperttp/transport-undici
# or
npm install @hyperttp/transport-undici

```

## 🚀 Usage

### Basic Initialization with Core

```typescript
import { HyperClient } from "@hyperttp/core";
import { UndiciTransport } from "@hyperttp/transport-undici";

const client = new HyperClient({
  baseUrl: "https://api.example.com",
  transport: new UndiciTransport({
    network: {
      maxConcurrent: 500, // Maximum concurrent sockets
      pipelining: 8, // Request pipelining depth per socket
      keepAliveTimeout: 30000, // Socket keep-alive timeout in ms
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

### Using an External (Custom) Dispatcher

If your application already manages a global `undici` Agent or Pool
(e.g., for proxy configurations or Unix domain sockets), you can inject it directly:

```typescript
import { Pool } from "undici";
import { UndiciTransport } from "@hyperttp/transport-undici";

const customPool = new Pool("http://localhost:3000", {
  connections: 100,
  connect: { rejectUnauthorized: false },
});

const transport = new UndiciTransport({
  dispatcher: customPool, // Injecting the existing instance
});
```

> ⚠️ **Note:** When a `dispatcher` is provided from an external context,
> `transport.close()` and `transport.destroy()` calls within `hyperttp`
> are ignored to prevent side effects in the parent environment.
> Managing the pool lifecycle remains the responsibility of your application architecture.

## 🛠 Abort & Timeout Architecture

The transport utilizes an atomic `combineSignal` utility that couples the user's external
`AbortSignal` with an internal task-limiting timer:

1. **Dispatch Handler Level**: During the `onResponseData` streaming phase, if the abort signal gets triggered,
   the underlying socket is immediately terminated via `controller.abort()`.
2. **Error Policy Level**:
   Low-level header timeouts (`UND_ERR_HEADERS_TIMEOUT`) and body timeouts (`UND_ERR_BODY_TIMEOUT`)
   are gracefully normalized into standard `AbortError` instances while preserving the original `cause` for diagnostics.

## 📄 License

MIT
