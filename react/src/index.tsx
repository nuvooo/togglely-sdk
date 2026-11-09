/**
 * Togglely React SDK
 *
 * Provides React hooks and context for feature toggles
 *
 * Usage:
 * ```tsx
 * import { TogglelyProvider, useToggle, useToggles } from '@togglely/sdk-react';
 *
 * function App() {
 *   return (
 *     <TogglelyProvider
 *       apiKey="your-api-key"
 *       environment="production"
 *       baseUrl="https://your-togglely-instance.com"
 *     >
 *       <MyComponent />
 *     </TogglelyProvider>
 *   );
 * }
 *
 * function MyComponent() {
 *   const isEnabled = useToggle('new-feature', false);
 *
 *   return isEnabled ? <NewFeature /> : <OldFeature />;
 * }
 * ```
 */

import {
  type ToggleContext,
  TogglelyClient,
  type TogglelyConfig,
  TogglelyEventType,
  type TogglelyState,
} from '@togglely/sdk-core'
import React, {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

// ==================== Context ====================

interface TogglelyContextValue {
  client: TogglelyClient | null
  state: TogglelyState
}

const TogglelyContext = createContext<TogglelyContextValue>({
  client: null,
  state: {
    isReady: false,
    isOffline: false,
    lastError: null,
    lastFetch: null,
  },
})

// ==================== Provider ====================

export interface TogglelyProviderProps
  extends Omit<TogglelyConfig, 'offlineFallback' | 'envPrefix'> {
  children: ReactNode
  /** Initial toggles for SSR / offline mode */
  initialToggles?: Record<string, any>
  /** Initial context (e.g., userId, tenantId) */
  initialContext?: ToggleContext
  /** Enable offline fallback (default: true) */
  offlineFallback?: boolean
}

export function TogglelyProvider({
  children,
  initialToggles,
  initialContext,
  offlineFallback = true,
  ...config
}: TogglelyProviderProps) {
  const [client] = useState(
    () =>
      // Default strategy: 'realtime' in browsers, 'manual' during SSR
      new TogglelyClient({
        ...config,
        // Part of the first request: avoids a second fetch for the context
        context: initialContext
          ? { ...config.context, ...initialContext }
          : config.context,
        offlineFallback,
        // Network starts in the effect: StrictMode may call this
        // initializer twice and discard one instance
        autoFetch: false,
      })
  )
  const destroyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startedClient = useRef<TogglelyClient | null>(null)

  const [state, setState] = useState<TogglelyState>(client.getState())

  // Inject initial toggles for SSR if provided (no refetch on changes)
  useEffect(() => {
    if (initialToggles && typeof window !== 'undefined') {
      ;(window as any).__TOGGLELY_TOGGLES = initialToggles
    }
  }, [initialToggles])

  // Lifecycle: once per client (inline props do not refetch)
  useEffect(() => {
    // Re-run with the same client (StrictMode): keep it
    if (destroyTimer.current) {
      clearTimeout(destroyTimer.current)
      destroyTimer.current = null
    }

    const unsubscribeReady = client.on('ready', (newState) =>
      setState(newState)
    )
    const unsubscribeUpdate = client.on('update', (newState) =>
      setState(newState)
    )
    const unsubscribeError = client.on('error', (newState) =>
      setState(newState)
    )
    const unsubscribeOffline = client.on('offline', (newState) =>
      setState(newState)
    )
    const unsubscribeOnline = client.on('online', (newState) =>
      setState(newState)
    )

    // Initial fetch, starts the realtime stream; once per client
    if (config.autoFetch !== false && startedClient.current !== client) {
      startedClient.current = client
      client.refresh()?.catch(() => {})
    }

    return () => {
      unsubscribeReady()
      unsubscribeUpdate()
      unsubscribeError()
      unsubscribeOffline()
      unsubscribeOnline()
      // Deferred: StrictMode unmounts and re-mounts effects with the same
      // client; only a real unmount closes stream and timers
      destroyTimer.current = setTimeout(() => client.destroy(), 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  return (
    <TogglelyContext.Provider value={{ client, state }}>
      {children}
    </TogglelyContext.Provider>
  )
}

/**
 * SSR Helper: Fetch all toggles for a specific environment and context.
 * Use this in getServerSideProps (Next.js) or separate SSR loaders.
 */
export async function getTogglelyState(
  config: Omit<TogglelyConfig, 'offlineFallback' | 'envPrefix'>,
  context?: ToggleContext
): Promise<Record<string, any>> {
  const client = new TogglelyClient({
    ...config,
    autoFetch: false, // Disable auto-fetch for SSR
    offlineFallback: false,
    // One-off request: no change stream on the server
    refreshStrategy: 'manual',
  })

  if (context) {
    client.setContext(context)
  }

  try {
    // Initial fetch
    await client.refresh()
    return client.getAllToggles()
  } finally {
    client.destroy()
  }
}

// ==================== Hooks ====================

/**
 * Get the Togglely client instance
 */
export function useTogglelyClient(): TogglelyClient {
  const { client } = useContext(TogglelyContext)
  if (!client) {
    throw new Error('useTogglelyClient must be used within a TogglelyProvider')
  }
  return client
}

/**
 * Get the current Togglely state
 */
export function useTogglelyState(): TogglelyState {
  const { state } = useContext(TogglelyContext)
  return state
}

/**
 * Check if Togglely is ready (toggles have been fetched at least once)
 */
export function useTogglelyReady(): boolean {
  const { state } = useContext(TogglelyContext)
  return state.isReady
}

/**
 * Check if Togglely is in offline mode
 */
export function useTogglelyOffline(): boolean {
  const { state } = useContext(TogglelyContext)
  return state.isOffline
}

/**
 * Hook to check if a boolean feature toggle is enabled
 */
export function useToggle(key: string, defaultValue: boolean = false): boolean {
  const client = useTogglelyClient()
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    let mounted = true

    const checkToggle = async () => {
      const result = await client.isEnabled(key, defaultValue)
      if (mounted) {
        setValue(result)
      }
    }

    checkToggle()

    // Re-check when toggles are updated
    const unsubscribe = client.on('update', checkToggle)

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [client, key, defaultValue])

  return value
}

/**
 * Hook to check if a feature flag is enabled (regardless of its value).
 * Use this for BOOLEAN flags where "enabled" means the feature is on.
 * Unlike useToggle which checks `enabled && value === true`,
 * this only checks the `enabled` field.
 */
export function useEnabled(
  key: string,
  defaultValue: boolean = false
): boolean {
  const client = useTogglelyClient()
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    let mounted = true

    const checkToggle = async () => {
      const result = await client.getValue(key)
      if (mounted) {
        setValue(result !== null ? result.enabled : defaultValue)
      }
    }

    checkToggle()

    const unsubscribe = client.on('update', checkToggle)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [client, key, defaultValue])

  return value
}

/**
 * Hook to get a string toggle value
 */
export function useStringToggle(
  key: string,
  defaultValue: string = ''
): string {
  const client = useTogglelyClient()
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    let mounted = true

    const getValue = async () => {
      const result = await client.getString(key, defaultValue)
      if (mounted) {
        setValue(result)
      }
    }

    getValue()

    const unsubscribe = client.on('update', getValue)

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [client, key, defaultValue])

  return value
}

/**
 * Hook to get a number toggle value
 */
export function useNumberToggle(key: string, defaultValue: number = 0): number {
  const client = useTogglelyClient()
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    let mounted = true

    const getValue = async () => {
      const result = await client.getNumber(key, defaultValue)
      if (mounted) {
        setValue(result)
      }
    }

    getValue()

    const unsubscribe = client.on('update', getValue)

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [client, key, defaultValue])

  return value
}

/**
 * Hook to get a JSON toggle value
 */
export function useJSONToggle<T = any>(
  key: string,
  defaultValue: T = {} as T
): T {
  const client = useTogglelyClient()
  const [value, setValue] = useState<T>(defaultValue)

  useEffect(() => {
    let mounted = true

    const getValue = async () => {
      const result = await client.getJSON<T>(key, defaultValue)
      if (mounted) {
        setValue(result)
      }
    }

    getValue()

    const unsubscribe = client.on('update', getValue)

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [client, key, defaultValue])

  return value
}

/**
 * Hook to get all toggles
 */
export function useToggles(): Record<string, { value: any; enabled: boolean }> {
  const client = useTogglelyClient()
  const [toggles, setToggles] = useState<
    Record<string, { value: any; enabled: boolean }>
  >({})

  useEffect(() => {
    const updateToggles = () => {
      setToggles(client.getAllToggles())
    }

    updateToggles()

    const unsubscribe = client.on('update', updateToggles)

    return () => unsubscribe()
  }, [client])

  return toggles
}

/**
 * Hook to set context for toggle evaluation
 */
export function useTogglelyContext(): {
  setContext: (context: ToggleContext) => void
  clearContext: () => void
  context: ToggleContext
} {
  const client = useTogglelyClient()
  const [context, setContextState] = useState<ToggleContext>({})

  const setContext = useCallback(
    (newContext: ToggleContext) => {
      client.setContext(newContext)
      setContextState(client.getContext())
    },
    [client]
  )

  const clearContext = useCallback(() => {
    client.clearContext()
    setContextState({})
  }, [client])

  return { setContext, clearContext, context }
}

// ==================== Components ====================

export interface FeatureToggleProps {
  /** Toggle key to check */
  toggle: string
  /** Content to render when toggle is enabled */
  children: ReactNode
  /** Content to render when toggle is disabled (optional) */
  fallback?: ReactNode
  /** Default value if toggle is not found */
  defaultValue?: boolean
}

/**
 * Component to conditionally render content based on a feature toggle
 */
export function FeatureToggle({
  toggle,
  children,
  fallback = null,
  defaultValue = false,
}: FeatureToggleProps) {
  const isEnabled = useToggle(toggle, defaultValue)
  return <>{isEnabled ? children : fallback}</>
}

export interface FeatureToggleSwitchProps {
  /** Toggle key to check */
  toggle: string
  /** Default value if toggle is not found */
  defaultValue?: boolean
  /** Children should be FeatureToggleCase components */
  children: ReactNode
}

interface FeatureToggleCaseProps {
  /** Render when toggle matches this value */
  when: boolean
  /** Content to render */
  children: ReactNode
}

/**
 * Case component for FeatureToggleSwitch
 */
export function FeatureToggleCase({ children }: FeatureToggleCaseProps) {
  return <>{children}</>
}

/**
 * Switch component for feature toggles with multiple cases
 */
export function FeatureToggleSwitch({
  toggle,
  defaultValue = false,
  children,
}: FeatureToggleSwitchProps) {
  const isEnabled = useToggle(toggle, defaultValue)

  let match: ReactNode = null
  let defaultCase: ReactNode = null

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) return

    if (child.type === FeatureToggleCase) {
      const { when, children: caseChildren } = child.props
      if (when === isEnabled) {
        match = caseChildren
      }
      if (when === undefined) {
        defaultCase = caseChildren
      }
    }
  })

  return <>{match ?? defaultCase}</>
}

// ==================== HOCs ====================

export interface WithFeatureToggleOptions {
  toggle: string
  defaultValue?: boolean
  fallback?: React.ComponentType<any>
}

/**
 * Higher-order component to wrap a component with feature toggle check
 */
export function withFeatureToggle<P extends object>(
  Component: React.ComponentType<P>,
  options: WithFeatureToggleOptions
): React.FC<P> {
  return function WithFeatureToggleWrapper(props: P) {
    const isEnabled = useToggle(options.toggle, options.defaultValue ?? false)

    if (!isEnabled) {
      if (options.fallback) {
        return <options.fallback {...props} />
      }
      return null
    }

    return <Component {...props} />
  }
}

// ==================== Suspense Integration ====================

/**
 * Hook that suspends until toggles are ready
 * Use with React.Suspense
 */
export function useTogglelySuspense(): TogglelyClient {
  const client = useTogglelyClient()
  const state = useTogglelyState()

  if (!state.isReady) {
    throw new Promise<void>((resolve) => {
      const unsubscribe = client.on('ready', () => {
        unsubscribe()
        resolve()
      })
    })
  }

  return client
}

// Re-export core types
export type {
  RefreshStrategy,
  ToggleContext,
  TogglelyConfig,
  TogglelyEventType,
  TogglelyState,
} from '@togglely/sdk-core'

export {
  createOfflineTogglesScript,
  TogglelyClient,
  togglesToEnvVars,
} from '@togglely/sdk-core'
