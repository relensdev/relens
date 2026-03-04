import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installNetworkInterceptor, uninstallNetworkInterceptor, applyUrlRedaction } from '../network-interceptor.js';
import type { NetworkEntry } from '../types.js';

let originalFetch: typeof window.fetch;
let originalXhrOpen: typeof XMLHttpRequest.prototype.open;
let originalXhrSend: typeof XMLHttpRequest.prototype.send;

beforeEach(() => {
  // Save real references before any patching
  originalFetch = window.fetch;
  originalXhrOpen = XMLHttpRequest.prototype.open;
  originalXhrSend = XMLHttpRequest.prototype.send;

  // Install a mock fetch that resolves successfully
  window.fetch = vi.fn().mockResolvedValue(
    new Response('ok', {
      status: 200,
      headers: { 'content-length': '2' },
    }),
  );
});

afterEach(() => {
  // Force-reset ref count by uninstalling until originals are restored
  // (handles test failures that leave interceptor installed)
  try { uninstallNetworkInterceptor('test'); } catch { /* ignore */ }
  try { uninstallNetworkInterceptor('test2'); } catch { /* ignore */ }

  // Restore originals
  window.fetch = originalFetch;
  XMLHttpRequest.prototype.open = originalXhrOpen;
  XMLHttpRequest.prototype.send = originalXhrSend;
});

describe('Network Interceptor', () => {
  it('captures url, method, status, and duration from fetch', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    await window.fetch('https://api.example.com/data', { method: 'POST' });

    // Wait for the .then() handler to fire
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://api.example.com/data');
    expect(entries[0].method).toBe('POST');
    expect(entries[0].status).toBe(200);
    expect(entries[0].durationMs).toBeTypeOf('number');
    expect(entries[0].initiator).toBe('fetch');
    expect(entries[0].responseSize).toBe(2);
    expect(entries[0].timestamp).toBeTypeOf('number');
  });

  it('captures error field on fetch rejection', async () => {
    window.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    try {
      await window.fetch('https://api.example.com/fail');
    } catch { /* expected */ }

    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].error).toBe('Network failure');
    expect(entries[0].status).toBeNull();
  });

  it('XHR interception patches open and send, captures metadata', () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    // Verify XHR prototype was patched
    const savedOpen = originalXhrOpen;
    expect(XMLHttpRequest.prototype.open).not.toBe(savedOpen);

    // Create an XHR and verify open/send work without errors
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', 'https://api.example.com/xhr-data');

    // Metadata is stored internally (WeakMap) — verified through captured entries on send
    // Here we verify the prototype was patched and open doesn't throw
    expect(XMLHttpRequest.prototype.open).not.toBe(savedOpen);

    uninstallNetworkInterceptor('test');

    // Verify restore
    expect(XMLHttpRequest.prototype.open).toBe(savedOpen);
  });

  it('idempotent install — calling twice only patches once', async () => {
    const entries1: NetworkEntry[] = [];
    const entries2: NetworkEntry[] = [];

    installNetworkInterceptor('test', (entry) => entries1.push(entry));
    installNetworkInterceptor('test2', (entry) => entries2.push(entry));

    await window.fetch('https://api.example.com/test');
    await new Promise((r) => setTimeout(r, 10));

    // First callback should be active (ref count incremented but not re-patched)
    // The active callback is the one from the first install
    expect(entries1.length + entries2.length).toBe(1);

    uninstallNetworkInterceptor('test'); // decrement to 1
    uninstallNetworkInterceptor('test2'); // decrement to 0, restore
  });

  it('uninstall restores original fetch', () => {
    const mockFetch = window.fetch;

    installNetworkInterceptor('test', () => {});

    // fetch should be patched (different function)
    expect(window.fetch).not.toBe(mockFetch);

    uninstallNetworkInterceptor('test');

    // fetch should be restored to the mock
    expect(window.fetch).toBe(mockFetch);
  });

  it('dispatches __relens_network__ CustomEvent', async () => {
    const events: NetworkEntry[] = [];
    const handler = (e: Event) => {
      events.push((e as CustomEvent<NetworkEntry>).detail);
    };

    // Note: the event is dispatched by bridge-worker, not the interceptor itself.
    // The interceptor calls the callback, which in the full pipeline posts to the worker.
    // Here we test that the callback fires correctly.
    installNetworkInterceptor('test', (entry) => {
      // Simulate what bridge-worker does for the fallback path
      window.dispatchEvent(
        new CustomEvent('__relens_network__', { detail: entry }),
      );
    });

    window.addEventListener('__relens_network__', handler);

    await window.fetch('https://api.example.com/event-test');
    await new Promise((r) => setTimeout(r, 10));

    window.removeEventListener('__relens_network__', handler);
    uninstallNetworkInterceptor('test');

    expect(events).toHaveLength(1);
    expect(events[0].url).toBe('https://api.example.com/event-test');
  });

  it('re-throws fetch errors so app code still sees them', async () => {
    // Make the underlying fetch throw synchronously
    window.fetch = vi.fn().mockImplementation(() => {
      throw new Error('Sync fetch error');
    });

    installNetworkInterceptor('test', () => {});

    await expect(async () => {
      await window.fetch('https://api.example.com/throws');
    }).rejects.toThrow('Sync fetch error');

    uninstallNetworkInterceptor('test');
  });

  it('filters out chrome-extension:// URLs', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    await window.fetch('chrome-extension://abc123/some-resource');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(0);
  });

  it('defaults method to GET when not specified', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    await window.fetch('https://api.example.com/get');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries[0].method).toBe('GET');
  });

  it('captures Request object URL as fetch input', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    const req = new Request('https://api.example.com/request-obj');
    await window.fetch(req);
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    // URL is extracted from Request.url
    expect(entries[0].url).toBe('https://api.example.com/request-obj');
    expect(entries[0].initiator).toBe('fetch');
  });

  it('default sanitizeUrl strips query parameters from fetch URLs', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    await window.fetch('https://api.example.com/data?token=secret123&page=2');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://api.example.com/data');
  });

  it('custom sanitizeUrl runs before query param stripping', async () => {
    const entries: NetworkEntry[] = [];
    // Custom sanitizer can modify the path; query params are always stripped after
    const customSanitize = (url: string) => url.replace(/\/secret-path/, '/redacted-path');

    installNetworkInterceptor('test', (entry) => entries.push(entry), customSanitize);

    await window.fetch('https://api.example.com/secret-path?token=abc');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    // sanitizeUrl modified the path, then query params were stripped
    expect(entries[0].url).toBe('https://api.example.com/redacted-path');
  });

  it('sanitizeUrl receives raw URL including query string', async () => {
    const receivedUrls: string[] = [];
    const spy = (url: string) => {
      receivedUrls.push(url);
      return url;
    };

    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry), spy);

    await window.fetch('https://api.example.com/path?key=value');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(receivedUrls).toHaveLength(1);
    // sanitizeUrl receives the raw URL with query params
    expect(receivedUrls[0]).toBe('https://api.example.com/path?key=value');
    // Query params are always stripped after sanitizeUrl runs
    expect(entries[0].url).toBe('https://api.example.com/path');
  });

  it('fetch error entries also have sanitized URLs', async () => {
    window.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    try {
      await window.fetch('https://api.example.com/fail?auth=token123');
    } catch { /* expected */ }

    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://api.example.com/fail');
    expect(entries[0].error).toBe('Network failure');
  });

  it('synchronous fetch throw entries also have sanitized URLs', async () => {
    window.fetch = vi.fn().mockImplementation(() => {
      throw new Error('Sync error');
    });

    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    try {
      await window.fetch('https://api.example.com/throws?session=abc');
    } catch { /* expected */ }

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://api.example.com/throws');
  });

  it('URL without query parameters is unchanged by default sanitizer', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    await window.fetch('https://api.example.com/clean-path');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://api.example.com/clean-path');
  });

  it('truncates long error messages on fetch rejection to 200 chars', async () => {
    const longMessage = 'x'.repeat(300);
    window.fetch = vi.fn().mockRejectedValue(new Error(longMessage));

    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    try {
      await window.fetch('https://api.example.com/fail');
    } catch { /* expected */ }

    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].error!.length).toBe(203); // 200 + '...'
    expect(entries[0].error!.endsWith('...')).toBe(true);
  });

  it('truncates long error messages on synchronous fetch throw to 200 chars', async () => {
    const longMessage = 'y'.repeat(250);
    window.fetch = vi.fn().mockImplementation(() => {
      throw new Error(longMessage);
    });

    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    try {
      await window.fetch('https://api.example.com/throws');
    } catch { /* expected */ }

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].error!.length).toBe(203); // 200 + '...'
    expect(entries[0].error!.endsWith('...')).toBe(true);
  });

  it('does not truncate short error messages', async () => {
    window.fetch = vi.fn().mockRejectedValue(new Error('short error'));

    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    try {
      await window.fetch('https://api.example.com/fail');
    } catch { /* expected */ }

    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].error).toBe('short error');
  });

  it('sanitizeUrl and urlRedaction reset to defaults after uninstall', async () => {
    // Install with custom sanitizer and 'host' redaction
    const entries1: NetworkEntry[] = [];
    installNetworkInterceptor(
      'test',
      (entry) => entries1.push(entry),
      (url) => url, // pass-through sanitizer
      'host',
    );

    await window.fetch('https://api.example.com/path?key=val');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    // query params stripped, then 'host' redaction strips origin
    expect(entries1[0].url).toBe('/path');

    // Re-install without custom sanitizer or redaction — should default to stripping only
    const entries2: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries2.push(entry));

    await window.fetch('https://api.example.com/path?key=val');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries2[0].url).toBe('https://api.example.com/path');
  });
});

describe('XHR end-to-end', () => {
  // Replace XHR.prototype.send with a no-op before each XHR test so jsdom
  // doesn't attempt a real network request (which causes unhandled rejections).
  // The interceptor will wrap this no-op; we manually dispatch loadend instead.
  let noopSend: typeof XMLHttpRequest.prototype.send;

  beforeEach(() => {
    noopSend = function () {} as any;
    XMLHttpRequest.prototype.send = noopSend;
  });

  it('captures full XHR flow via loadend event', () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/xhr-data');

    // Override status and getResponseHeader before dispatching loadend
    Object.defineProperty(xhr, 'status', { value: 200, writable: false });
    const origGetHeader = xhr.getResponseHeader.bind(xhr);
    xhr.getResponseHeader = (name: string) => {
      if (name.toLowerCase() === 'content-length') return '42';
      return origGetHeader(name);
    };

    xhr.send();

    // Dispatch loadend to trigger the interceptor's listener
    xhr.dispatchEvent(new Event('loadend'));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      url: 'https://api.example.com/xhr-data',
      method: 'GET',
      status: 200,
      initiator: 'xhr',
      responseSize: 42,
    });
    expect(entries[0].durationMs).toBeTypeOf('number');
    expect(entries[0].timestamp).toBeTypeOf('number');
  });

  it('XHR status=0 sets error to Network error', () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.example.com/fail');

    // status 0 = network error
    Object.defineProperty(xhr, 'status', { value: 0, writable: false });
    xhr.getResponseHeader = () => null;

    xhr.send();
    xhr.dispatchEvent(new Event('loadend'));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBeNull();
    expect(entries[0].error).toBe('Network error');
  });

  it('XHR Content-Length missing results in null responseSize', () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/no-length');

    Object.defineProperty(xhr, 'status', { value: 200, writable: false });
    xhr.getResponseHeader = () => null;

    xhr.send();
    xhr.dispatchEvent(new Event('loadend'));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].responseSize).toBeNull();
    expect(entries[0].status).toBe(200);
  });

  it('default sanitizeUrl strips query parameters from XHR URLs', () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry));

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/data?token=secret&page=1');

    Object.defineProperty(xhr, 'status', { value: 200, writable: false });
    xhr.getResponseHeader = () => null;

    xhr.send();
    xhr.dispatchEvent(new Event('loadend'));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://api.example.com/data');
  });

  it('custom sanitizeUrl is applied to XHR URLs (query params still stripped)', () => {
    const entries: NetworkEntry[] = [];
    // Custom sanitizer modifies the path; query params are always stripped after
    const customSanitize = (url: string) => url.replace(/\/data/, '/redacted');

    installNetworkInterceptor('test', (entry) => entries.push(entry), customSanitize);

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/data?token=secret&page=1');

    Object.defineProperty(xhr, 'status', { value: 200, writable: false });
    xhr.getResponseHeader = () => null;

    xhr.send();
    xhr.dispatchEvent(new Event('loadend'));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://api.example.com/redacted');
  });
});

describe('applyUrlRedaction (unit)', () => {
  it('"none" returns URL as-is', () => {
    expect(applyUrlRedaction('https://api.example.com/v1/users', 'none'))
      .toBe('https://api.example.com/v1/users');
  });

  it('"host" strips scheme and host, keeps pathname', () => {
    expect(applyUrlRedaction('https://api.example.com/v1/users', 'host'))
      .toBe('/v1/users');
  });

  it('"host" preserves root pathname', () => {
    expect(applyUrlRedaction('https://api.example.com/', 'host'))
      .toBe('/');
  });

  it('"host" preserves deep path', () => {
    expect(applyUrlRedaction('https://api.example.com/a/b/c/d', 'host'))
      .toBe('/a/b/c/d');
  });

  it('"path" keeps origin only', () => {
    expect(applyUrlRedaction('https://api.example.com/v1/users', 'path'))
      .toBe('https://api.example.com');
  });

  it('"path" preserves port in origin', () => {
    expect(applyUrlRedaction('http://localhost:3000/api/data', 'path'))
      .toBe('http://localhost:3000');
  });

  it('"full" returns deterministic hash with net_ prefix', () => {
    const result = applyUrlRedaction('https://api.example.com/v1/users', 'full');
    expect(result).toMatch(/^net_[0-9a-f]{8}$/);
  });

  it('"full" produces the same hash for the same URL', () => {
    const hash1 = applyUrlRedaction('https://api.example.com/v1/users', 'full');
    const hash2 = applyUrlRedaction('https://api.example.com/v1/users', 'full');
    expect(hash1).toBe(hash2);
  });

  it('"full" produces different hashes for different URLs', () => {
    const hash1 = applyUrlRedaction('https://api.example.com/v1/users', 'full');
    const hash2 = applyUrlRedaction('https://api.example.com/v1/posts', 'full');
    expect(hash1).not.toBe(hash2);
  });

  it('"full" hash is stable across multiple calls', () => {
    const url = 'https://api.stripe.com/v1/charges';
    const results = Array.from({ length: 10 }, () => applyUrlRedaction(url, 'full'));
    expect(new Set(results).size).toBe(1);
  });

  // Edge cases
  it('"host" with malformed URL returns input as-is', () => {
    expect(applyUrlRedaction('/relative/path', 'host')).toBe('/relative/path');
  });

  it('"path" with malformed URL returns empty string', () => {
    expect(applyUrlRedaction('/relative/path', 'path')).toBe('');
  });

  it('"full" with empty string returns a hash', () => {
    const result = applyUrlRedaction('', 'full');
    expect(result).toMatch(/^net_[0-9a-f]{8}$/);
  });

  it('"none" with empty string returns empty string', () => {
    expect(applyUrlRedaction('', 'none')).toBe('');
  });

  it('"host" with empty string returns empty string', () => {
    // Empty string is malformed, so falls through to return as-is
    expect(applyUrlRedaction('', 'host')).toBe('');
  });

  it('"full" hashes are different for URLs that differ only in path', () => {
    const hash1 = applyUrlRedaction('https://api.example.com/a', 'full');
    const hash2 = applyUrlRedaction('https://api.example.com/b', 'full');
    expect(hash1).not.toBe(hash2);
  });
});

describe('URL redaction integration (fetch)', () => {
  it('urlRedaction="none" preserves full URL (default behavior)', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry), undefined, 'none');

    await window.fetch('https://api.example.com/v1/users?token=abc');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    // Query params stripped, but full URL otherwise preserved
    expect(entries[0].url).toBe('https://api.example.com/v1/users');
  });

  it('urlRedaction="host" strips origin from captured URL', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry), undefined, 'host');

    await window.fetch('https://api.example.com/v1/users?token=abc');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('/v1/users');
  });

  it('urlRedaction="path" keeps origin only', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry), undefined, 'path');

    await window.fetch('https://api.example.com/v1/users?token=abc');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://api.example.com');
  });

  it('urlRedaction="full" hashes the URL', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry), undefined, 'full');

    await window.fetch('https://api.example.com/v1/users?token=abc');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toMatch(/^net_[0-9a-f]{8}$/);
  });

  it('urlRedaction="full" same endpoint produces same hash across calls', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry), undefined, 'full');

    await window.fetch('https://api.example.com/v1/users');
    await new Promise((r) => setTimeout(r, 10));
    await window.fetch('https://api.example.com/v1/users');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(2);
    expect(entries[0].url).toBe(entries[1].url);
  });

  it('query params are stripped at every redaction level', async () => {
    for (const level of ['none', 'host', 'path', 'full'] as const) {
      const entries: NetworkEntry[] = [];
      installNetworkInterceptor('test', (entry) => entries.push(entry), undefined, level);

      await window.fetch('https://api.example.com/data?secret=123&page=2');
      await new Promise((r) => setTimeout(r, 10));

      uninstallNetworkInterceptor('test');

      expect(entries).toHaveLength(1);
      // No entry at any level should contain query params
      expect(entries[0].url).not.toContain('?');
      expect(entries[0].url).not.toContain('secret');
    }
  });

  it('sanitizeUrl + urlRedaction: sanitizeUrl runs first, then redaction', async () => {
    const entries: NetworkEntry[] = [];
    // sanitizeUrl normalizes path segments
    const sanitize = (url: string) => url.replace(/\/users\/\d+/, '/users/:id');

    installNetworkInterceptor('test', (entry) => entries.push(entry), sanitize, 'host');

    await window.fetch('https://api.example.com/users/42?token=abc');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    // sanitizeUrl ran first: /users/42 -> /users/:id
    // query params stripped: removes ?token=abc
    // urlRedaction='host': strips origin, keeps path
    expect(entries[0].url).toBe('/users/:id');
  });

  it('sanitizeUrl + urlRedaction="full": hash is based on sanitized URL', async () => {
    const entries: NetworkEntry[] = [];
    // sanitizeUrl normalizes IDs so same-endpoint URLs hash identically
    const sanitize = (url: string) => url.replace(/\/users\/\d+/, '/users/:id');

    installNetworkInterceptor('test', (entry) => entries.push(entry), sanitize, 'full');

    await window.fetch('https://api.example.com/users/42');
    await new Promise((r) => setTimeout(r, 10));
    await window.fetch('https://api.example.com/users/99');
    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(2);
    // Both normalize to the same URL, so hashes match
    expect(entries[0].url).toBe(entries[1].url);
    expect(entries[0].url).toMatch(/^net_[0-9a-f]{8}$/);
  });

  it('error entries also have redacted URLs', async () => {
    window.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry), undefined, 'host');

    try {
      await window.fetch('https://api.example.com/fail?auth=token');
    } catch { /* expected */ }

    await new Promise((r) => setTimeout(r, 10));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('/fail');
    expect(entries[0].error).toBe('Network failure');
  });

  it('synchronous throw entries also have redacted URLs', async () => {
    window.fetch = vi.fn().mockImplementation(() => {
      throw new Error('Sync error');
    });

    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry), undefined, 'path');

    try {
      await window.fetch('https://api.example.com/throws?session=abc');
    } catch { /* expected */ }

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://api.example.com');
  });
});

describe('URL redaction integration (XHR)', () => {
  let noopSend: typeof XMLHttpRequest.prototype.send;

  beforeEach(() => {
    noopSend = function () {} as any;
    XMLHttpRequest.prototype.send = noopSend;
  });

  it('urlRedaction="host" strips origin from XHR URLs', () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry), undefined, 'host');

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/v1/data?key=secret');

    Object.defineProperty(xhr, 'status', { value: 200, writable: false });
    xhr.getResponseHeader = () => null;

    xhr.send();
    xhr.dispatchEvent(new Event('loadend'));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('/v1/data');
  });

  it('urlRedaction="path" keeps origin only for XHR URLs', () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry), undefined, 'path');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.example.com/v1/data');

    Object.defineProperty(xhr, 'status', { value: 201, writable: false });
    xhr.getResponseHeader = () => null;

    xhr.send();
    xhr.dispatchEvent(new Event('loadend'));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://api.example.com');
  });

  it('urlRedaction="full" hashes XHR URLs', () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('test', (entry) => entries.push(entry), undefined, 'full');

    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://api.example.com/v1/data');

    Object.defineProperty(xhr, 'status', { value: 200, writable: false });
    xhr.getResponseHeader = () => null;

    xhr.send();
    xhr.dispatchEvent(new Event('loadend'));

    uninstallNetworkInterceptor('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toMatch(/^net_[0-9a-f]{8}$/);
  });
});

describe('Multi-provider urlRedaction (most restrictive wins)', () => {
  it('second provider with stricter redaction overrides the first', async () => {
    const entries: NetworkEntry[] = [];
    const cb = (entry: NetworkEntry) => entries.push(entry);

    // First provider: no redaction
    installNetworkInterceptor('provider-a', cb, undefined, 'none');
    // Second provider: full redaction (stricter)
    installNetworkInterceptor('provider-b', cb, undefined, 'full');

    await window.fetch('https://api.example.com/users');

    uninstallNetworkInterceptor('provider-b');
    uninstallNetworkInterceptor('provider-a');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toMatch(/^net_[0-9a-f]{8}$/);
  });

  it('first provider with stricter redaction is preserved when second is less strict', async () => {
    const entries: NetworkEntry[] = [];
    const cb = (entry: NetworkEntry) => entries.push(entry);

    // First provider: full redaction
    installNetworkInterceptor('provider-a', cb, undefined, 'full');
    // Second provider: no redaction (less strict — should NOT downgrade)
    installNetworkInterceptor('provider-b', cb, undefined, 'none');

    await window.fetch('https://api.example.com/users');

    uninstallNetworkInterceptor('provider-b');
    uninstallNetworkInterceptor('provider-a');

    expect(entries).toHaveLength(1);
    expect(entries[0].url).toMatch(/^net_[0-9a-f]{8}$/);
  });

  it('host < path < full strictness ordering is respected', async () => {
    const entries: NetworkEntry[] = [];
    const cb = (entry: NetworkEntry) => entries.push(entry);

    installNetworkInterceptor('provider-a', cb, undefined, 'host');
    installNetworkInterceptor('provider-b', cb, undefined, 'path');

    await window.fetch('https://api.example.com/users');

    uninstallNetworkInterceptor('provider-b');
    uninstallNetworkInterceptor('provider-a');

    expect(entries).toHaveLength(1);
    // 'path' is stricter than 'host', so origin only
    expect(entries[0].url).toBe('https://api.example.com');
  });
});
