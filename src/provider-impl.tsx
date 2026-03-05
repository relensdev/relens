'use client';

import { Profiler, Fragment, useRef, useEffect } from 'react';
import { RenderEntry, RelensProviderProps } from './types.js';
import { walkFiberTree } from './fiber-walker/index.js';
import { acquireWorker, releaseWorker } from './bridge-worker.js';
import type { BridgeWorker } from './bridge-worker.js';
import { installNetworkInterceptor, uninstallNetworkInterceptor } from './network-interceptor.js';
import { installUserEventCapture, uninstallUserEventCapture } from './user-event-capture.js';
import { VERSION } from './version.js';

const DEFAULT_MAX_ENTRIES = 2000;

const isBrowser = typeof window !== 'undefined';

// Ensure the global is initialized synchronously so onRender never races useEffect
function ensureGlobal(): void {
  if (!isBrowser) return;
  if (!window.__RELENS__) {
    window.__RELENS__ = { version: 2, packageVersion: VERSION, renders: [], networks: [], userEvents: [], providers: {} };
  } else {
    window.__RELENS__.version = 2;
    window.__RELENS__.packageVersion = VERSION;
    if (!Array.isArray(window.__RELENS__.networks)) {
      window.__RELENS__.networks = [];
    }
    if (!Array.isArray(window.__RELENS__.userEvents)) {
      window.__RELENS__.userEvents = [];
    }
    if (!window.__RELENS__.providers) {
      window.__RELENS__.providers = {};
    }
  }
}

// Snapshot captured synchronously in onRender
interface RenderSnapshot {
  profilerId: string;
  phase: 'mount' | 'update' | 'nested-update';
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
  timestamp: number;
  marker: Element | null;
}

/**
 * Full implementation of the Relens provider, loaded lazily in development.
 *
 * This component contains all instrumentation logic: fiber walking, worker
 * creation, network interception, and user event capture. In production builds,
 * this file is never imported (the thin wrapper in `provider.tsx` returns a
 * Fragment instead).
 *
 * Multiple providers can coexist in the same React tree. They share:
 * - A single Web Worker (singleton, ref-counted)
 * - A single set of `window.__RELENS__` data arrays (renders, networks, userEvents)
 * - A single network interceptor and user event capture instance
 *
 * Each provider registers itself in `window.__RELENS__.providers[profileId]`
 * on mount and unregisters on unmount.
 */
export function RelensProviderImpl({
  children,
  id = 'default',
  enabled = true,
  maxEntries: rawMaxEntries = DEFAULT_MAX_ENTRIES,
  sampleRate: rawSampleRate = 1.0,
  filter,
  network = false,
  sanitizeUrl,
  urlRedaction = 'none',
  userEvents = false,
  instanceId,
}: RelensProviderProps) {
  // Validate and clamp provider props
  let maxEntries = rawMaxEntries;
  let sampleRate = rawSampleRate;

  if (maxEntries < 1 || maxEntries > 100000) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[Relens] maxEntries=${maxEntries} is out of range [1, 100000]. Clamping to ${Math.max(1, Math.min(100000, maxEntries))}.`,
      );
    }
    maxEntries = Math.max(1, Math.min(100000, maxEntries));
  }

  if (sampleRate < 0 || sampleRate > 1) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[Relens] sampleRate=${sampleRate} is out of range [0, 1]. Clamping to ${Math.max(0, Math.min(1, sampleRate))}.`,
      );
    }
    sampleRate = Math.max(0, Math.min(1, sampleRate));
  }

  const markerRef = useRef<HTMLSpanElement>(null);
  const workerRef = useRef<BridgeWorker | null>(null);

  // Network interceptor lifecycle — install/uninstall based on `network` and `enabled` props
  useEffect(() => {
    if (!enabled || !network || !isBrowser) return;

    installNetworkInterceptor(id, (entry) => {
      workerRef.current?.postNetworkEntry(entry);
    }, sanitizeUrl, urlRedaction);

    return () => {
      uninstallNetworkInterceptor(id);
    };
  }, [network, enabled, id, sanitizeUrl, urlRedaction]);

  // User event capture lifecycle — install/uninstall based on `userEvents` and `enabled` props
  useEffect(() => {
    if (!enabled || !userEvents || !isBrowser) return;

    installUserEventCapture(id, (entry) => {
      workerRef.current?.postUserEvent(entry);
    });

    return () => {
      uninstallUserEventCapture(id);
    };
  }, [userEvents, enabled, id]);

  // Provider registration in global registry + shared Worker lifecycle
  useEffect(() => {
    if (!enabled || !isBrowser) return;

    // Acquire a reference to the shared singleton Worker
    workerRef.current = acquireWorker(maxEntries);

    // Register this provider in the global registry (ref-counted)
    if (window.__RELENS__?.providers) {
      const existing = window.__RELENS__.providers[id];
      if (existing) {
        existing.refCount++;
        existing.config = { network, userEvents, sampleRate, maxEntries };
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `[Relens] Multiple <RelensProvider> components share id="${id}" (refCount=${existing.refCount}). ` +
            `Each provider should have a unique id prop. Shared IDs may produce confusing telemetry.`,
          );
        }
      } else {
        window.__RELENS__.providers[id] = {
          config: { network, userEvents, sampleRate, maxEntries },
          refCount: 1,
        };
      }
    }

    return () => {
      // Unregister from the global registry (ref-counted)
      if (window.__RELENS__?.providers) {
        const entry = window.__RELENS__.providers[id];
        if (entry) {
          entry.refCount--;
          if (entry.refCount <= 0) {
            delete window.__RELENS__.providers[id];
          }
        }
      }
      // Release the shared Worker reference
      releaseWorker();
      workerRef.current = null;
    };
  }, [id, enabled, network, userEvents, sampleRate, maxEntries]);

  // Early return after all hooks — safe to toggle `enabled` at runtime
  if (!enabled) {
    return <Fragment>{children}</Fragment>;
  }

  // Synchronous init — safe to call on every render (idempotent)
  ensureGlobal();

  // Set instanceId on global (shared across all providers)
  if (isBrowser && window.__RELENS__) {
    if (instanceId) {
      const current = window.__RELENS__.instanceId;
      if (
        process.env.NODE_ENV !== 'production' &&
        current &&
        current !== 'default' &&
        current !== instanceId
      ) {
        console.warn(
          `[Relens] <RelensProvider instanceId="${instanceId}"> conflicts with ` +
          `existing instanceId="${current}". All providers on the same page should ` +
          `use the same instanceId. Data will route to "${instanceId}".`,
        );
      }
      // eslint-disable-next-line react-hooks/immutability -- intentional idempotent global for extension bridge
      window.__RELENS__.instanceId = instanceId;
    }
  }

  const processSnapshot = (snapshot: RenderSnapshot) => {
    try {
      const walkResult = walkFiberTree(snapshot.marker);

      // Filter: check profiler ID and component names
      if (filter) {
        const profilerMatches = filter(snapshot.profilerId);
        const componentMatches =
          walkResult != null && walkResult.components.some((c) => filter(c.name));
        if (!profilerMatches && !componentMatches) {
          return;
        }
      }

      const entry: RenderEntry = {
        id: snapshot.profilerId,
        phase: snapshot.phase,
        actualDuration: snapshot.actualDuration,
        baseDuration: snapshot.baseDuration,
        startTime: snapshot.startTime,
        commitTime: snapshot.commitTime,
        timestamp: snapshot.timestamp,
      };

      if (walkResult != null) {
        entry.components = walkResult.components;
        if (walkResult.rootCauseComponents.length > 0) {
          entry.rootCauseComponents = walkResult.rootCauseComponents;
        }
      }

      if (!isBrowser) return;

      // Post to worker (or fallback: synchronous global update + event dispatch)
      workerRef.current?.postEntry(entry);

      // Dispatch a separate event with DOM element references for the heatmap
      // overlay. This is a non-serializable event (HTMLElement refs can't pass
      // through postMessage), so it's separate from the regular __relens_render__
      // event that the page-script forwards to the extension.
      if (walkResult?.domElements && walkResult.domElements.size > 0 && entry.components) {
        window.dispatchEvent(
          new CustomEvent('__relens_render_dom__', {
            detail: { profileId: entry.id, components: entry.components, domElements: walkResult.domElements },
          }),
        );
      }
    } catch {
      // Provider must never crash the host app
    }
  };

  const onRender = (
    profilerId: string,
    phase: 'mount' | 'update' | 'nested-update',
    actualDuration: number,
    baseDuration: number,
    startTime: number,
    commitTime: number,
  ) => {
    try {
      // Sample rate check — fast bailout before any work
      if (sampleRate < 1.0 && Math.random() >= sampleRate) {
        return;
      }

      const snapshot: RenderSnapshot = {
        profilerId,
        phase,
        actualDuration,
        baseDuration,
        startTime,
        commitTime,
        timestamp: Date.now(),
        marker: markerRef.current,
      };

      // Walk fiber tree synchronously — the Profiler's onRender fires during
      // commitLayoutEffects when the fiber tree is in its committed state.
      // Deferring (e.g. queueMicrotask) risks seeing a LATER commit's fiber
      // state if useLayoutEffect triggers a synchronous nested commit.
      processSnapshot(snapshot);
    } catch {
      // Provider must never crash the host app
    }
  };

  return (
    <Profiler id={id} onRender={onRender}>
      {children}
      <span ref={markerRef} style={{display: 'none'}} data-relens-marker />
    </Profiler>
  );
}
