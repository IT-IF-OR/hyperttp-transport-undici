# Changelog

All notable changes to `@hyperttp/transport-undici` will be documented in this file.

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
