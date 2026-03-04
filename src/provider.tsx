'use client';

import { Fragment, lazy, Suspense } from 'react';
import type { RelensProviderProps } from './types.js';

// In production: bundlers replace process.env.NODE_ENV with 'production',
// making this `false ? lazy(...) : null`. The dynamic import is in a dead
// branch, so bundlers eliminate it (and the entire provider-impl chunk).
const LazyProvider =
  process.env.NODE_ENV !== 'production'
    ? lazy(() =>
        import('./provider-impl.js').then((m) => ({
          default: m.RelensProviderImpl,
        })),
      )
    : null;

/**
 * Instruments a React subtree for performance telemetry collection.
 *
 * Wrap your app (or any subtree) in `<RelensProvider>` to start collecting
 * render timing, component re-renders, prop changes, effect firing patterns,
 * network requests, and user interactions.
 *
 * All props are optional with sensible defaults. Set `enabled={false}` for
 * true zero overhead — no Profiler, no Worker, no listeners.
 *
 * In production builds (`NODE_ENV=production`), this component renders a plain
 * Fragment with zero instrumentation code in the bundle.
 *
 * @example
 * ```tsx
 * <RelensProvider instanceId="my-app" network userEvents>
 *   <App />
 * </RelensProvider>
 * ```
 */
export function RelensProvider(props: RelensProviderProps) {
  if (process.env.NODE_ENV === 'production' || !LazyProvider) {
    return <Fragment>{props.children}</Fragment>;
  }

  return (
    <Suspense fallback={<Fragment>{props.children}</Fragment>}>
      <LazyProvider {...props} />
    </Suspense>
  );
}
