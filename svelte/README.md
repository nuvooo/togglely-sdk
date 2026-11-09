# Togglely Svelte SDK

Svelte stores, actions, and Svelte 5 runes support for [Togglely](https://togglely.io) feature flag management.

## Installation

```bash
npm install @togglely/sdk-svelte
```

`@togglely/sdk-core` is included as a dependency -- you do not need to install it separately.

## Quick Start

```svelte
<!-- App.svelte -->
<script>
  import { initTogglely, toggle } from '@togglely/sdk-svelte';

  initTogglely({
    apiKey: 'your-api-key',
    project: 'my-project',
    environment: 'production',
    baseUrl: 'https://togglely.io',
  });

  const isEnabled = toggle('new-feature', false);
</script>

{#if $isEnabled}
  <NewFeature />
{:else}
  <OldFeature />
{/if}
```

## Initialization

### `initTogglely(config: TogglelyConfig): TogglelyClient`

Initialize the global Togglely client. Call this once in your root layout or entry point. If called again, it destroys the previous instance and creates a new one.

```typescript
import { initTogglely } from '@togglely/sdk-svelte';

initTogglely({
  apiKey: 'your-api-key',
  project: 'my-project',
  environment: 'production',
  baseUrl: 'https://togglely.io',
  tenantId: 'brand-a',              // optional
  offlineJsonPath: '/toggles.json', // optional
  refreshStrategy: 'realtime',      // optional (default; 'manual' to opt out)
});
```

### `getTogglelyClient(): TogglelyClient`

Access the global client instance. Throws if `initTogglely` has not been called.

```typescript
const client = getTogglelyClient();
await client.refresh();
```

### `destroyTogglely(): void`

Destroy the global client and clean up timers/handlers.

```typescript
import { destroyTogglely } from '@togglely/sdk-svelte';
destroyTogglely();
```

## Real-time Updates & Caching

Since 1.3.0 the client uses `refreshStrategy: 'realtime'` by default: it keeps a live change stream (Server-Sent Events) open and only refetches when flags changed, using conditional requests (`ETag` → `304 Not Modified`). If streaming is unavailable (stream limit, older Togglely server, proxies) it falls back to ETag polling every `refreshIntervalMs` (default 30 s). Changed values reach your UI automatically through the `update` event.

- **Lifecycle:** call `destroyTogglely()` to close the stream; `initTogglely()` destroys a previous instance automatically.
- **SSR (SvelteKit):** on the server `initTogglely()` defaults to `refreshStrategy: 'manual'`, so no stream is opened during rendering.
- **Opt out:** pass `refreshStrategy: 'manual'` to restore the pre-1.3.0 behaviour (fetch only on `refresh()`).
- **Hidden tabs:** the stream is closed after 5 minutes in a hidden tab and resumed when visible (`pauseWhenHidden: false` disables this).
- **Debugging:** `client.on('stream-connected' | 'stream-disconnected', ...)`.

**Server-side reactions:** to run backend logic when a flag changes (cache invalidation, deployments, audit trails), configure a **webhook** for the project in the Togglely dashboard (*Project settings → Webhooks*) instead of keeping a stream open in every server process.

See [Core SDK — Real-time Updates & Caching](../core/README.md#real-time-updates--caching) for the details.

## Stores API Reference

All stores are Svelte `Readable` stores. Use the `$` prefix in templates and reactive statements.

### `toggle(key: string, defaultValue?: boolean): Readable<boolean>`

Reactive boolean toggle store.

```svelte
<script>
  import { toggle } from '@togglely/sdk-svelte';
  const isEnabled = toggle('new-feature', false);
</script>

{#if $isEnabled}
  <div>New Feature!</div>
{/if}
```

### `stringToggle(key: string, defaultValue?: string): Readable<string>`

Reactive string toggle store.

```svelte
<script>
  import { stringToggle } from '@togglely/sdk-svelte';
  const message = stringToggle('welcome-message', 'Hello!');
</script>

<h1>{$message}</h1>
```

### `numberToggle(key: string, defaultValue?: number): Readable<number>`

Reactive number toggle store.

```svelte
<script>
  import { numberToggle } from '@togglely/sdk-svelte';
  const limit = numberToggle('max-items', 10);
</script>

<p>Max items: {$limit}</p>
```

### `jsonToggle<T>(key: string, defaultValue?: T): Readable<T>`

Reactive JSON toggle store.

```svelte
<script>
  import { jsonToggle } from '@togglely/sdk-svelte';
  const config = jsonToggle('app-config', { theme: 'dark' });
</script>

<div data-theme={$config.theme}>Content</div>
```

### `toggles(): Readable<Record<string, ToggleValue>>`

All cached toggles as a reactive store.

```svelte
<script>
  import { toggles } from '@togglely/sdk-svelte';
  const all = toggles();
</script>

{#each Object.entries($all) as [key, t]}
  <p>{key}: {t.enabled ? 'ON' : 'OFF'} = {t.value}</p>
{/each}
```

### `togglelyState(): Readable<TogglelyState>`

Reactive SDK state store. Updates on all events (ready, update, error, offline, online).

```svelte
<script>
  import { togglelyState } from '@togglely/sdk-svelte';
  const state = togglelyState();
</script>

{#if !$state.isReady}
  <p>Loading...</p>
{:else if $state.isOffline}
  <p>Offline mode</p>
{/if}
```

### `togglelyReady(): Readable<boolean>`

Derived store that is `true` when toggles are ready.

### `togglelyOffline(): Readable<boolean>`

Derived store that is `true` when in offline mode.

## Actions

### `featureToggle(node: HTMLElement, key: string): { destroy(): void }`

Svelte action that shows/hides an element based on a toggle. Sets `display: none` when disabled.

```svelte
<script>
  import { featureToggle } from '@togglely/sdk-svelte';
</script>

<div use:featureToggle={'new-feature'}>
  Only visible when 'new-feature' is enabled
</div>
```

## Context Management

### `setTogglelyContext(context: ToggleContext): void`

Merge new attributes into the targeting context.

```typescript
import { setTogglelyContext } from '@togglely/sdk-svelte';
setTogglelyContext({ userId: '123', country: 'DE' });
```

### `getTogglelyContext(): ToggleContext`

Return a copy of the current context.

### `clearTogglelyContext(): void`

Reset the context to an empty object.

## Svelte 5 Runes Support

### `createToggle(key: string, defaultValue?: boolean): { value: boolean }`

For Svelte 5 users, `createToggle` returns a reactive object compatible with runes.

```svelte
<script>
  import { createToggle } from '@togglely/sdk-svelte';

  const feature = createToggle('new-feature', false);
</script>

{#if feature.value}
  <NewFeature />
{/if}
```

Note: The returned object has a getter-based `.value` property. In Svelte 5 you can use it with `$state`:

```svelte
<script>
  import { createToggle } from '@togglely/sdk-svelte';
  let feature = $state(createToggle('new-feature', false));
</script>
```

## SSR Integration (SvelteKit)

### Client-Only Initialization

The simplest approach -- initialize only in the browser:

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { browser } from '$app/environment';
  import { initTogglely } from '@togglely/sdk-svelte';

  if (browser) {
    initTogglely({
      apiKey: import.meta.env.VITE_TOGGLELY_APIKEY,
      project: 'my-project',
      environment: 'production',
      baseUrl: 'https://togglely.io',
    });
  }
</script>

<slot />
```

### Server-Side Pre-Fetching

Fetch toggles in a `+layout.server.ts` load function and pass them to the client:

```typescript
// src/routes/+layout.server.ts
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ fetch }) => {
  const response = await fetch(
    `${process.env.TOGGLELY_BASE_URL}/sdk/flags/${process.env.TOGGLELY_PROJECT}/${process.env.TOGGLELY_ENV}`,
    { headers: { Authorization: `Bearer ${process.env.TOGGLELY_APIKEY}` } }
  );
  const toggles = await response.json();
  return { toggles };
};
```

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { browser } from '$app/environment';
  import { initTogglely } from '@togglely/sdk-svelte';

  export let data;

  if (browser) {
    // Inject server-fetched toggles as offline fallback
    window.__TOGGLELY_TOGGLES = data.toggles;

    initTogglely({
      apiKey: import.meta.env.VITE_TOGGLELY_APIKEY,
      project: 'my-project',
      environment: 'production',
      baseUrl: 'https://togglely.io',
    });
  }
</script>

<slot />
```

## FeatureToggle Component (Recipe)

Create a reusable wrapper component:

```svelte
<!-- FeatureToggle.svelte -->
<script>
  import { toggle } from '@togglely/sdk-svelte';

  export let name;
  export let defaultValue = false;

  const isEnabled = toggle(name, defaultValue);
</script>

{#if $isEnabled}
  <slot />
{:else}
  <slot name="fallback" />
{/if}
```

Usage:

```svelte
<FeatureToggle name="new-feature">
  <NewVersion />
  <svelte:fragment slot="fallback">
    <OldVersion />
  </svelte:fragment>
</FeatureToggle>
```

## Build-Time JSON Generation

```json
{
  "scripts": {
    "build": "togglely-pull --apiKey=$TOGGLELY_APIKEY --project=my-project --environment=production --output=./static/toggles.json && vite build"
  }
}
```

```typescript
initTogglely({
  ...config,
  offlineJsonPath: '/toggles.json',
});
```

## Re-exports

The Svelte SDK re-exports from `@togglely/sdk-core`:

- `TogglelyClient`
- `createOfflineTogglesScript`
- `togglesToEnvVars`
- Types: `ToggleContext`, `TogglelyConfig`, `TogglelyState`

## License

MIT
