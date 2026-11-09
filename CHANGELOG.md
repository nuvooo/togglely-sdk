# Changelog

All packages (`@togglely/sdk-core`, `-react`, `-vue`, `-svelte`, `@togglely/sdk` vanilla) share one version.

## 1.3.0

### Added

- **Real-time updates** (`refreshStrategy: 'realtime'`): after the initial fetch the client opens `GET /sdk/stream/:project/:environment` (Server-Sent Events over `fetch`, no dependencies) and refetches only on `flags-changed`. Reconnects with exponential backoff + jitter, 60 s heartbeat watchdog, catch-up via `Last-Event-ID`.
- **ETag caching** for all strategies: `If-None-Match` on every flags request; `304 Not Modified` keeps the cache without an `update` event.
- Automatic **fallback to ETag polling** (`refreshIntervalMs`, default 30 s): on `429 STREAM_LIMIT` (respecting `Retry-After`), repeated stream failures, servers without stream (`404`/`405`) and platforms without streaming `fetch`.
- Options `streamPath`, `pauseWhenHidden`, `onChange`; events `stream-connected` / `stream-disconnected`; export `detectDefaultRefreshStrategy()` and type `RefreshStrategy`.
- Vanilla: `destroyTogglely()`.

### Default behaviour per platform

| Platform | Default `refreshStrategy` | Notes |
|----------|---------------------------|-------|
| Browsers with streaming `fetch` | `'realtime'` | Stream closed after 5 min in a hidden tab (`pauseWhenHidden`), reopened when visible |
| Node.js | `'manual'` (unchanged) | `'realtime'` can be set explicitly for long-running servers; the stream keeps the process alive until `destroy()`. Prefer project webhooks for server-side reactions |
| SSR (Next.js, Nuxt, SvelteKit) | `'manual'` (unchanged) | No stream during rendering |
| React Native, Web Workers | `'manual'` (unchanged) | Explicit `'realtime'` uses ETag polling only (no streaming `fetch`) |

Opt out in browsers with `refreshStrategy: 'manual'`.

### Changed

- `setContext()` / `clearContext()` fetch immediately with the realtime strategy.
- `destroy()` closes the stream, aborts pending requests and resolves pending reads with `null` (accessors return their default value); a destroyed client does no more network requests.
- React: `TogglelyProvider` starts fetching in its effect (once per client, StrictMode-safe) and destroys the client on unmount; `initialContext` is part of the first request; `getTogglelyState()` destroys its temporary client.
- Vue: the client is destroyed on `app.unmount()` (all Vue 3 versions).
- Vanilla: `initTogglely()` destroys a previous instance; in Node the instance is kept at module level.
- Exceptions in event handlers are logged instead of breaking refreshes.

### Fixed

- `update` was not emitted when the value of an existing flag changed (change detection ignored nested values).
- Offline JSON (`offlineJsonPath`) loaded after the server response no longer overrides server data.
