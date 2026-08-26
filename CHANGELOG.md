# Changelog

All notable changes to `@hyperttp/transport-undici` will be documented in this file.

## [0.3.2] - 2026-08-27

### Changed

- Updated peer dependencies to`hcacher@^0.3.0`.

## [0.3.1] - 2026-08-24

### Fixed

- Normalized uncompressed Undici response bodies from Node.js `Readable` to Web `ReadableStream<Uint8Array>` in `execute()` and `rawRequest()`, so `stream: true` requests preserve streaming for `@hyperttp/core` clients.

## [0.3.0] - 2026-08-23

### Added

- Added the `rest` protocol declaration and `supports()` capability check required by the `@hyperttp/core@2` transport contract.
- Added package-owned types for stealth settings, cache options, and raw response payloads.

### Changed

- **Breaking:** aligned the transport with `@hyperttp/types@^0.3.0`; `execute()` now returns the raw response body stream instead of transport-level `json()` and `text()` helpers.
- **Breaking:** moved retry, redirect, timeout, and response parsing policies out of the transport and into `@hyperttp/core` or its plugins.
- Requests sent through an external Undici `Dispatcher` now include the target origin, allowing dispatchers that are not bound to a single origin.
- Replaced the URL `CacheManager` with a bounded in-memory fast-path cache.
- Updated peer dependencies to `@hyperttp/types@^0.3.0`, `hcacher@^0.2.0`, and `undici@^8.10.0`.
- Reworked the English and Russian documentation for the `@hyperttp/core@2` API and refreshed benchmark results.

### Fixed

- Pre-aborted requests now return a rejected promise instead of throwing synchronously.
- Decompressed responses no longer mutate Undici's original headers object when removing `content-encoding`.
- Improved header normalization for flat header arrays, cookies, and multiple `set-cookie` values.

### Removed

- Removed the internal `_raw` response extension and transport-level parsed-body helpers.

## [0.2.5] - 2026-07-18

### Added

- Integrated `hcacher` as peer dependency for in-memory caching with TTL and LRU eviction.
- Added `cookieStore`, `cookieStringCache`, and `responseCache` instances using `CacheManager`.
- Added `cache` and `cookieCache` config options to `UndiciTransportConfig.network`.

### Changed

- Replaced manual `urlCache` (Map) with `CacheManager` from `hcacher`.
- Simplified `parseUrlCached()` — eviction now handled automatically by `CacheManager`.

## [0.2.4] - 2026-07-18

### Fixed

- Fix TypeScript type incompatibility in `Readable.fromWeb()` call for Node.js stream interop in decompress util.

## [0.2.3] - 2026

### Changed

- Refactored type definitions for broader compatibility.
- Extended `TransportRequest` / `TransportResponse` types with additional fields.
- Expanded and improved `helpers.ts` utility functions.

## [0.2.1] - 2026

### Added

- Added `decompress.ts` with streaming decompression support (gzip, deflate, brotli) via `DecompressionStream` API and Node.js fallback.
- Added oxlint and oxfmt configuration files.

### Changed

- Reworked undici transport core — expanded request/response handling.
- Improved `helpers.ts` with additional utility functions.
- Updated build tooling and peer dependency versions.

## [0.2.0] - 2026

### Changed

- Major refactor: extracted helpers into dedicated `helpers.ts` module.
- Removed `decompress.ts` (buffer-based) and `helper.ts`; replaced with cleaner `helpers.ts`.
- Updated type definitions and tsconfig for stricter compilation.
- Switched linting/formatting to oxlint + oxfmt.

## [0.1.7] - 2026

### Changed

- Simplified undici transport by removing internal helper utilities and decompress logic.
- Cleaned up types and renamed internal structures.

## [0.1.6] - 2026

### Added

- Introduced `decompress.ts` for content-encoding response body decoding (gzip, deflate, brotli).

### Changed

- Expanded decompression and response handling in undici transport.

## [0.1.5] - 2026

### Changed

- Major expansion of the undici transport implementation.
- Added redirect handling with identity/auth header filtering (`IDENTITY_HEADERS_TO_DROP_ON_BODYLESS_REDIRECT`, `AUTH_HEADERS_TO_DROP_ON_CROSS_ORIGIN_REDIRECT`).
- Added `normalizeHeaders` improvements (set-cookie join, append logic).
- Added `toOrigin` and `normalizeMethod` helpers.

## [0.1.0] - 2026

### Added

- Initial release of `@hyperttp/transport-undici`.
- Core HTTP transport implementation using Undici `Pool`.
- Retry logic with exponential backoff for retryable errors.
- TypeScript types via `@hyperttp/types` integration.
- Benchmark server and test suites (unit, integration, real-world).
- Decompression utilities (gzip, deflate, brotli).
