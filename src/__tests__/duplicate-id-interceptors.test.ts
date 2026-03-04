import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installNetworkInterceptor, uninstallNetworkInterceptor } from '../network-interceptor.js';
import { installUserEventCapture, uninstallUserEventCapture } from '../user-event-capture.js';
import type { NetworkEntry, UserEventEntry } from '../types.js';

describe('Network interceptor with duplicate profile IDs', () => {
  let originalFetch: typeof window.fetch;

  beforeEach(() => {
    originalFetch = window.fetch;
    window.fetch = vi.fn().mockResolvedValue(
      new Response('ok', {
        status: 200,
        headers: { 'content-length': '2' },
      }),
    );
  });

  afterEach(() => {
    // Force-reset: uninstall enough times to clear state
    try { uninstallNetworkInterceptor('dup'); } catch { /* ignore */ }
    try { uninstallNetworkInterceptor('dup'); } catch { /* ignore */ }
    try { uninstallNetworkInterceptor('dup'); } catch { /* ignore */ }
    window.fetch = originalFetch;
  });

  it('same profileId installed twice increments counter to 2', async () => {
    const entries: NetworkEntry[] = [];
    installNetworkInterceptor('dup', (entry) => entries.push(entry));
    installNetworkInterceptor('dup', (entry) => entries.push(entry));

    await window.fetch('https://api.example.com/test');
    await new Promise((r) => setTimeout(r, 10));

    // Only 1 entry because callback is from first install
    expect(entries).toHaveLength(1);

    // First uninstall: count goes to 1, interceptor stays
    uninstallNetworkInterceptor('dup');

    // Fetch should still be intercepted
    await window.fetch('https://api.example.com/test2');
    await new Promise((r) => setTimeout(r, 10));
    expect(entries).toHaveLength(2);

    // Second uninstall: count goes to 0, interceptor uninstalled
    uninstallNetworkInterceptor('dup');
  });

  it('first uninstall of duplicate ID does NOT restore originals', () => {
    const mockFetch = window.fetch;

    installNetworkInterceptor('dup', () => {});
    installNetworkInterceptor('dup', () => {});

    const patchedFetch = window.fetch;
    expect(patchedFetch).not.toBe(mockFetch);

    // First uninstall — should NOT restore originals
    uninstallNetworkInterceptor('dup');
    expect(window.fetch).toBe(patchedFetch); // still patched

    // Second uninstall — should restore originals
    uninstallNetworkInterceptor('dup');
    expect(window.fetch).toBe(mockFetch); // restored
  });

  it('extra uninstall calls do not underflow below zero', () => {
    installNetworkInterceptor('dup', () => {});

    // Uninstall once (correct)
    uninstallNetworkInterceptor('dup');

    // Extra uninstall calls should be no-ops, not crash or go negative
    uninstallNetworkInterceptor('dup');
    uninstallNetworkInterceptor('dup');

    // Installing again should work normally
    const entries: NetworkEntry[] = [];
    const mockFetch = window.fetch;
    window.fetch = vi.fn().mockResolvedValue(new Response('ok'));

    installNetworkInterceptor('dup', (entry) => entries.push(entry));

    // Should be patched
    expect(window.fetch).not.toBe(mockFetch);

    uninstallNetworkInterceptor('dup');
    window.fetch = mockFetch;
  });
});

describe('User event capture with duplicate profile IDs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    // Force-reset
    try { uninstallUserEventCapture('dup'); } catch { /* ignore */ }
    try { uninstallUserEventCapture('dup'); } catch { /* ignore */ }
    try { uninstallUserEventCapture('dup'); } catch { /* ignore */ }
    document.body.innerHTML = '';
  });

  it('same profileId installed twice increments counter to 2', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('dup', (entry) => entries.push(entry));
    installUserEventCapture('dup', (entry) => entries.push(entry));

    const btn = document.createElement('button');
    btn.textContent = 'Test';
    document.body.appendChild(btn);
    btn.click();

    // Only 1 entry because callback is from first install
    expect(entries).toHaveLength(1);

    // First uninstall: count goes to 1, listeners stay
    uninstallUserEventCapture('dup');

    btn.click();
    expect(entries).toHaveLength(2);

    // Second uninstall: count goes to 0, listeners removed
    uninstallUserEventCapture('dup');

    btn.click();
    expect(entries).toHaveLength(2); // no new entry
  });

  it('first uninstall of duplicate ID does NOT remove listeners', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('dup', (entry) => entries.push(entry));
    installUserEventCapture('dup', (entry) => entries.push(entry));

    const btn = document.createElement('button');
    btn.textContent = 'Test';
    document.body.appendChild(btn);

    // First uninstall — should NOT remove listeners
    uninstallUserEventCapture('dup');

    btn.click();
    expect(entries).toHaveLength(1); // listeners still active

    // Second uninstall — should remove listeners
    uninstallUserEventCapture('dup');

    btn.click();
    expect(entries).toHaveLength(1); // no new entry
  });

  it('extra uninstall calls do not underflow below zero', () => {
    installUserEventCapture('dup', () => {});

    // Uninstall once (correct)
    uninstallUserEventCapture('dup');

    // Extra uninstall calls should be no-ops
    uninstallUserEventCapture('dup');
    uninstallUserEventCapture('dup');

    // Installing again should work normally
    const entries: UserEventEntry[] = [];
    installUserEventCapture('dup', (entry) => entries.push(entry));

    const btn = document.createElement('button');
    btn.textContent = 'Test';
    document.body.appendChild(btn);
    btn.click();

    expect(entries).toHaveLength(1);

    uninstallUserEventCapture('dup');
  });
});
