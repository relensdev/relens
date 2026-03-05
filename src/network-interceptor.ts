import type { NetworkEntry, UrlRedaction } from './types.js';

type NetworkCallback = (entry: NetworkEntry) => void;

type SanitizeUrlFn = (url: string) => string;

/** Default sanitizer: strips query parameters to prevent leaking tokens, API keys, or PII. */
function defaultSanitizeUrl(url: string): string {
  return url.split('?')[0];
}

/**
 * FNV-1a hash — fast, deterministic, non-cryptographic.
 * Returns 8 lowercase hex characters (32 bits).
 */
function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5; // FNV offset basis (32-bit)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime (32-bit)
  }
  // Convert to unsigned 32-bit integer, then to 8 hex chars
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Apply URL redaction based on the configured level. Operates on an already
 * query-param-stripped URL (query stripping happens before this function).
 *
 * @param url - URL with query params already stripped
 * @param level - Redaction level
 * @returns Redacted URL string
 */
export function applyUrlRedaction(url: string, level: UrlRedaction): string {
  if (level === 'none') return url;

  if (level === 'full') {
    return 'net_' + fnv1aHash(url);
  }

  // For 'host' and 'path', parse with URL constructor
  try {
    const parsed = new URL(url);
    if (level === 'host') {
      // Strip scheme+host, keep pathname
      return parsed.pathname;
    }
    if (level === 'path') {
      // Keep origin only
      return parsed.origin;
    }
  } catch {
    // Malformed URL (e.g., relative path, empty string) — fall through
    if (level === 'host') {
      // Already looks like a path or is malformed; return as-is
      return url;
    }
    if (level === 'path') {
      // Cannot extract origin from a malformed URL; return empty string
      return '';
    }
  }

  return url;
}

let originalFetch: typeof window.fetch | null = null;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open | null = null;
let originalXhrSend: typeof XMLHttpRequest.prototype.send | null = null;
let activeCallback: NetworkCallback | null = null;
let activeSanitizeUrl: SanitizeUrlFn = defaultSanitizeUrl;
let activeUrlRedaction: UrlRedaction = 'none';

/**
 * Number of active providers that have `network={true}`. Uses a simple numeric
 * counter rather than a Set keyed by profileId, because the interceptor is a
 * global singleton and the provider registry (`window.__RELENS__.providers`)
 * owns the per-ID ref count. A numeric counter correctly handles duplicate
 * profileIds: two providers with the same id increment to 2, and both must
 * unmount before the interceptor uninstalls.
 */
let activeCount = 0;

/**
 * Run the full URL sanitization pipeline:
 * 1. sanitizeUrl callback (custom or default query-strip)
 * 2. Strip query params (always, unconditionally)
 * 3. urlRedaction transform
 */
function sanitizeAndRedact(rawUrl: string): string {
  let url = activeSanitizeUrl(rawUrl);
  // Always strip query params after the sanitize callback
  url = url.split('?')[0];
  return applyUrlRedaction(url, activeUrlRedaction);
}

/** Max length for error messages stored in NetworkEntry.error. */
const MAX_ERROR_LENGTH = 200;

function truncateError(msg: string): string {
  return msg.length > MAX_ERROR_LENGTH ? msg.slice(0, MAX_ERROR_LENGTH) + '...' : msg;
}

// WeakMap for storing XHR metadata — invisible to external code, no property collisions
const xhrMetadata = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

function shouldIgnoreUrl(url: string): boolean {
  return url.startsWith('chrome-extension://');
}

function patchFetch(): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;

  originalFetch = window.fetch;
  const saved = originalFetch;

  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();

    if (shouldIgnoreUrl(rawUrl)) {
      return saved.call(this, input, init);
    }

    const url = sanitizeAndRedact(rawUrl);
    const start = performance.now();
    const timestamp = Date.now();

    let responsePromise: Promise<Response>;
    try {
      responsePromise = saved.call(this, input, init);
    } catch (err) {
      const entry: NetworkEntry = {
        url,
        method,
        status: null,
        durationMs: Math.round((performance.now() - start) * 100) / 100,
        responseSize: null,
        initiator: 'fetch',
        timestamp,
        error: truncateError(err instanceof Error ? err.message : String(err)),
      };
      try { activeCallback?.(entry); } catch { /* never crash app */ }
      throw err;
    }

    responsePromise.then(
      (response) => {
        const durationMs = Math.round((performance.now() - start) * 100) / 100;
        const contentLength = response.headers.get('content-length');
        const entry: NetworkEntry = {
          url,
          method,
          status: response.status,
          durationMs,
          responseSize: contentLength != null ? parseInt(contentLength, 10) : null,
          initiator: 'fetch',
          timestamp,
        };
        try { activeCallback?.(entry); } catch { /* never crash app */ }
      },
      (err) => {
        const durationMs = Math.round((performance.now() - start) * 100) / 100;
        const entry: NetworkEntry = {
          url,
          method,
          status: null,
          durationMs,
          responseSize: null,
          initiator: 'fetch',
          timestamp,
          error: truncateError(err instanceof Error ? err.message : String(err)),
        };
        try { activeCallback?.(entry); } catch { /* never crash app */ }
      },
    );

    return responsePromise;
  };
}

function patchXhr(): void {
  if (typeof XMLHttpRequest === 'undefined') return;

  originalXhrOpen = XMLHttpRequest.prototype.open;
  originalXhrSend = XMLHttpRequest.prototype.send;

  const savedOpen = originalXhrOpen;
  const savedSend = originalXhrSend;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    ...rest: any[]
  ): void {
    xhrMetadata.set(this, { method: method.toUpperCase(), url: typeof url === 'string' ? url : url.toString() });
    return savedOpen.apply(this, [method, url, ...rest] as any);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
    const meta = xhrMetadata.get(this);
    const rawUrl = meta?.url ?? '';
    const method = meta?.method ?? 'GET';

    if (shouldIgnoreUrl(rawUrl)) {
      return savedSend.call(this, body);
    }

    const url = sanitizeAndRedact(rawUrl);
    const start = performance.now();
    const timestamp = Date.now();

    this.addEventListener('loadend', function () {
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      const contentLength = this.getResponseHeader('content-length');
      const entry: NetworkEntry = {
        url,
        method,
        status: this.status || null,
        durationMs,
        responseSize: contentLength != null ? parseInt(contentLength, 10) : null,
        initiator: 'xhr',
        timestamp,
      };
      if (this.status === 0) {
        entry.error = 'Network error';
      }
      try { activeCallback?.(entry); } catch { /* never crash app */ }
    });

    return savedSend.call(this, body);
  };
}

/**
 * Register a profileId as having `network={true}` and install the interceptor
 * if not already installed. The callback is shared across all providers --
 * network entries are page-level, not provider-scoped.
 *
 * @param profileId - The provider's profileId (its `id` prop)
 * @param callback - Called for each captured network entry. Only the first
 *   caller's callback is used (subsequent registrations reuse the same
 *   interceptor). This matches the old behavior but the callback is now
 *   decoupled from individual providers -- it should push to the shared global.
 * @param sanitizeUrl - Optional URL sanitizer. Receives the raw URL and returns
 *   a sanitized version. Defaults to stripping query parameters.
 * @param urlRedaction - URL redaction level. Defaults to `'none'`.
 */
/**
 * Redaction strictness ordering — higher index = more restrictive.
 * When multiple providers disagree, the most restrictive level wins.
 */
const REDACTION_ORDER: readonly UrlRedaction[] = ['none', 'host', 'path', 'full'];

export function installNetworkInterceptor(
  profileId: string,
  callback: NetworkCallback,
  sanitizeUrl?: (url: string) => string,
  urlRedaction?: UrlRedaction,
): void {
  activeCount++;

  // Always update urlRedaction — most restrictive across all providers wins.
  const requested = urlRedaction ?? 'none';
  if (REDACTION_ORDER.indexOf(requested) > REDACTION_ORDER.indexOf(activeUrlRedaction)) {
    activeUrlRedaction = requested;
  }

  if (activeCount > 1) return; // already patched

  activeCallback = callback;
  activeSanitizeUrl = sanitizeUrl ?? defaultSanitizeUrl;

  try {
    patchFetch();
  } catch { /* graceful */ }

  try {
    patchXhr();
  } catch { /* graceful */ }
}

/**
 * Decrement the active provider count. When the count reaches zero, the
 * interceptor is fully uninstalled and originals restored.
 *
 * @param profileId - The provider's profileId (kept for API compatibility).
 */
export function uninstallNetworkInterceptor(_profileId: string): void {
  activeCount = Math.max(0, activeCount - 1);

  if (activeCount > 0) return; // other providers still active

  activeCallback = null;
  activeSanitizeUrl = defaultSanitizeUrl;
  activeUrlRedaction = 'none';

  if (originalFetch) {
    window.fetch = originalFetch;
    originalFetch = null;
  }

  if (originalXhrOpen) {
    XMLHttpRequest.prototype.open = originalXhrOpen;
    originalXhrOpen = null;
  }

  if (originalXhrSend) {
    XMLHttpRequest.prototype.send = originalXhrSend;
    originalXhrSend = null;
  }
}
