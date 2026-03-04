import { WORKER_SOURCE } from './worker-source.js';
import type { RenderEntry, NetworkEntry, UserEventEntry } from './types.js';

export interface BridgeWorker {
  postEntry(entry: RenderEntry): void;
  postNetworkEntry(entry: NetworkEntry): void;
  postUserEvent(entry: UserEventEntry): void;
  terminate(): void;
  isWorkerAvailable(): boolean;
}

const isBrowser = typeof window !== 'undefined';

function pushToGlobalArrayAndDispatch<T>(
  arrayKey: 'renders' | 'networks' | 'userEvents',
  eventName: string,
  entry: T,
  maxEntries: number,
): void {
  if (!isBrowser) return;

  const bridge = window.__RELENS__;
  if (!bridge) return;

  const arr = bridge[arrayKey] as T[];
  if (!Array.isArray(arr)) return;

  arr.push(entry);
  if (arr.length > maxEntries) {
    arr.splice(0, arr.length - maxEntries);
  }

  window.dispatchEvent(
    new CustomEvent(eventName, { detail: entry }),
  );
}

/**
 * Create a standalone BridgeWorker instance. Used in tests to verify
 * the fallback (non-Worker) code path in jsdom. Production code should
 * use `acquireWorker()` / `releaseWorker()` for multi-provider support.
 */
export function createBridgeWorker(maxEntries: number): BridgeWorker {
  let worker: Worker | null = null;
  let workerAvailable = false;

  try {
    if (
      isBrowser &&
      typeof Worker !== 'undefined' &&
      typeof Blob !== 'undefined' &&
      typeof URL !== 'undefined'
    ) {
      const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url);
      URL.revokeObjectURL(url);
      workerAvailable = true;

      worker.onerror = () => {
        worker?.terminate();
        workerAvailable = false;
        worker = null;
      };

      worker.postMessage({ type: 'CONFIG', maxEntries });
    }
  } catch {
    workerAvailable = false;
    worker = null;
  }

  function postEntry(entry: RenderEntry): void {
    // Always dispatch synchronously — heatmap and extension page-script
    // need the event immediately, not after a Worker round-trip.
    pushToGlobalArrayAndDispatch('renders', '__relens_render__', entry, maxEntries);
    // Also store in Worker ring buffer
    if (workerAvailable && worker) {
      worker.postMessage({ type: 'ENTRY', data: entry });
    }
  }

  function postNetworkEntry(entry: NetworkEntry): void {
    pushToGlobalArrayAndDispatch('networks', '__relens_network__', entry, maxEntries);
    if (workerAvailable && worker) {
      worker.postMessage({ type: 'NETWORK_ENTRY', data: entry });
    }
  }

  function postUserEvent(entry: UserEventEntry): void {
    pushToGlobalArrayAndDispatch('userEvents', '__relens_user_event__', entry, maxEntries);
    if (workerAvailable && worker) {
      worker.postMessage({ type: 'USER_EVENT', data: entry });
    }
  }

  function terminate(): void {
    if (worker) {
      worker.terminate();
      worker = null;
      workerAvailable = false;
    }
  }

  function isWorkerAvailable(): boolean {
    return workerAvailable;
  }

  return { postEntry, postNetworkEntry, postUserEvent, terminate, isWorkerAvailable };
}

// ---------------------------------------------------------------------------
// Singleton shared Worker — used by multi-provider RelensProviderImpl
// ---------------------------------------------------------------------------

let sharedWorker: Worker | null = null;
let sharedWorkerAvailable = false;
let sharedRefCount = 0;
let sharedMaxEntries = 2000;

function ensureSharedWorker(maxEntries: number): void {
  if (sharedWorker) return;

  sharedMaxEntries = maxEntries;

  try {
    if (
      isBrowser &&
      typeof Worker !== 'undefined' &&
      typeof Blob !== 'undefined' &&
      typeof URL !== 'undefined'
    ) {
      const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      sharedWorker = new Worker(url);
      URL.revokeObjectURL(url);
      sharedWorkerAvailable = true;

      sharedWorker.onerror = () => {
        sharedWorker?.terminate();
        sharedWorkerAvailable = false;
        sharedWorker = null;
      };

      sharedWorker.postMessage({ type: 'CONFIG', maxEntries: sharedMaxEntries });
    }
  } catch {
    sharedWorkerAvailable = false;
    sharedWorker = null;
  }
}

/**
 * Acquire a reference to the shared singleton Worker.
 *
 * The first call creates the Worker; subsequent calls reuse it.
 * Each caller must call `releaseWorker()` when done (unmount).
 * The Worker is terminated when the last reference is released.
 */
export function acquireWorker(maxEntries: number): BridgeWorker {
  sharedRefCount++;

  // First provider creates the Worker
  if (sharedRefCount === 1) {
    ensureSharedWorker(maxEntries);
  } else if (maxEntries > sharedMaxEntries && sharedWorker && sharedWorkerAvailable) {
    // If a new provider requests a larger buffer, resize
    sharedMaxEntries = maxEntries;
    sharedWorker.postMessage({ type: 'CONFIG', maxEntries: sharedMaxEntries });
  }

  function postEntry(entry: RenderEntry): void {
    pushToGlobalArrayAndDispatch('renders', '__relens_render__', entry, sharedMaxEntries);
    if (sharedWorkerAvailable && sharedWorker) {
      sharedWorker.postMessage({ type: 'ENTRY', data: entry });
    }
  }

  function postNetworkEntry(entry: NetworkEntry): void {
    pushToGlobalArrayAndDispatch('networks', '__relens_network__', entry, sharedMaxEntries);
    if (sharedWorkerAvailable && sharedWorker) {
      sharedWorker.postMessage({ type: 'NETWORK_ENTRY', data: entry });
    }
  }

  function postUserEvent(entry: UserEventEntry): void {
    pushToGlobalArrayAndDispatch('userEvents', '__relens_user_event__', entry, sharedMaxEntries);
    if (sharedWorkerAvailable && sharedWorker) {
      sharedWorker.postMessage({ type: 'USER_EVENT', data: entry });
    }
  }

  function terminate(): void {
    // No-op for shared worker — use releaseWorker() instead
  }

  function isWorkerAvailable(): boolean {
    return sharedWorkerAvailable;
  }

  return { postEntry, postNetworkEntry, postUserEvent, terminate, isWorkerAvailable };
}

/**
 * Release a reference to the shared singleton Worker.
 *
 * When the last reference is released, the Worker is terminated.
 */
export function releaseWorker(): void {
  sharedRefCount--;
  if (sharedRefCount <= 0) {
    sharedRefCount = 0;
    if (sharedWorker) {
      sharedWorker.terminate();
      sharedWorker = null;
      sharedWorkerAvailable = false;
    }
  }
}

/**
 * Reset singleton state. Only for use in tests.
 * @internal
 */
export function _resetSharedWorker(): void {
  if (sharedWorker) {
    sharedWorker.terminate();
  }
  sharedWorker = null;
  sharedWorkerAvailable = false;
  sharedRefCount = 0;
  sharedMaxEntries = 2000;
}
