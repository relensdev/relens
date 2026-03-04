import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WORKER_SOURCE } from '../worker-source.js';
import { createBridgeWorker } from '../bridge-worker.js';
import type { RenderEntry, NetworkEntry, UserEventEntry } from '../types.js';

// Simulate the worker by evaluating its source in a controlled scope.
// Returns handles to the internal ring buffers so tests can verify storage
// without relying on any query protocol.
function createMockWorker() {
  const messages: any[] = [];

  // Build a mock `self` that captures postMessage calls
  const mockSelf = {
    onmessage: null as any,
    postMessage(data: any) {
      messages.push(data);
    },
  };

  // Wrap the worker source so we can extract references to the ring buffers.
  // The worker source declares `entries`, `networkEntries`, `userEventEntries`
  // as `var` — we capture them by appending a return statement.
  const wrappedSource = `
    ${WORKER_SOURCE}
    return { entries: entries, networkEntries: networkEntries, userEventEntries: userEventEntries };
  `;
  const fn = new Function('self', wrappedSource);
  const buffers = fn(mockSelf);
  const handler = mockSelf.onmessage;

  return {
    send(msg: any) {
      if (handler) handler({ data: msg });
    },
    messages,
    /** Direct access to the render ring buffer (for verification). */
    entries: buffers.entries as { toArray(): any[]; getCount(): number },
    /** Direct access to the network ring buffer (for verification). */
    networkEntries: buffers.networkEntries as { toArray(): any[]; getCount(): number },
    /** Direct access to the user event ring buffer (for verification). */
    userEventEntries: buffers.userEventEntries as { toArray(): any[]; getCount(): number },
  };
}

describe('Worker source (ring buffer)', () => {
  let worker: ReturnType<typeof createMockWorker>;

  beforeEach(() => {
    worker = createMockWorker();
  });

  it('stores an entry without sending a confirmation message', () => {
    const entry = { id: 'test', phase: 'mount', timestamp: 1 };
    worker.send({ type: 'ENTRY', data: entry });

    // No confirmation message — fire-and-forget
    expect(worker.messages).toHaveLength(0);
    expect(worker.entries.toArray()).toEqual([entry]);
  });

  it('stores multiple entries in order', () => {
    worker.send({ type: 'ENTRY', data: { id: 'a' } });
    worker.send({ type: 'ENTRY', data: { id: 'b' } });

    const data = worker.entries.toArray();
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe('a');
    expect(data[1].id).toBe('b');
  });

  it('enforces maxEntries cap (default 2000)', () => {
    for (let i = 0; i < 2005; i++) {
      worker.send({ type: 'ENTRY', data: { id: `e-${i}` } });
    }

    const data = worker.entries.toArray();
    expect(data).toHaveLength(2000);
    // Oldest entries should have been evicted
    expect(data[0].id).toBe('e-5');
  });

  it('CONFIG updates maxEntries and trims existing entries', () => {
    for (let i = 0; i < 10; i++) {
      worker.send({ type: 'ENTRY', data: { id: `e-${i}` } });
    }

    worker.send({ type: 'CONFIG', maxEntries: 3 });

    const data = worker.entries.toArray();
    expect(data).toHaveLength(3);
    // Should keep the 3 most recent
    expect(data[0].id).toBe('e-7');
  });

  it('CONFIG enforces new cap on subsequent entries', () => {
    worker.send({ type: 'CONFIG', maxEntries: 2 });

    worker.send({ type: 'ENTRY', data: { id: 'a' } });
    worker.send({ type: 'ENTRY', data: { id: 'b' } });
    worker.send({ type: 'ENTRY', data: { id: 'c' } });

    const data = worker.entries.toArray();
    expect(data).toHaveLength(2);
    expect(data[0].id).toBe('b');
    expect(data[1].id).toBe('c');
  });

  it('CLEAR empties all entries and sends CLEARED', () => {
    worker.send({ type: 'ENTRY', data: { id: 'a' } });
    worker.send({ type: 'ENTRY', data: { id: 'b' } });

    worker.send({ type: 'CLEAR' });

    expect(worker.messages).toHaveLength(1);
    expect(worker.messages[0]).toEqual({ type: 'CLEARED' });
    expect(worker.entries.toArray()).toHaveLength(0);
  });
});

describe('Worker source (circular buffer wrap-around)', () => {
  let worker: ReturnType<typeof createMockWorker>;

  beforeEach(() => {
    worker = createMockWorker();
    // Use a small capacity to test wrap-around quickly
    worker.send({ type: 'CONFIG', maxEntries: 5 });
  });

  it('maintains correct order after wrap-around', () => {
    // Push 8 entries into a buffer of capacity 5
    for (let i = 0; i < 8; i++) {
      worker.send({ type: 'ENTRY', data: { id: `e-${i}` } });
    }

    const data = worker.entries.toArray();
    expect(data).toHaveLength(5);
    // Should have entries 3-7 in order (oldest first)
    expect(data.map((d: any) => d.id)).toEqual(['e-3', 'e-4', 'e-5', 'e-6', 'e-7']);
  });

  it('handles exactly-at-capacity correctly', () => {
    for (let i = 0; i < 5; i++) {
      worker.send({ type: 'ENTRY', data: { id: `e-${i}` } });
    }

    const data = worker.entries.toArray();
    expect(data).toHaveLength(5);
    expect(data.map((d: any) => d.id)).toEqual(['e-0', 'e-1', 'e-2', 'e-3', 'e-4']);
  });

  it('handles single entry', () => {
    worker.send({ type: 'ENTRY', data: { id: 'only' } });
    expect(worker.entries.toArray()).toEqual([{ id: 'only' }]);
  });

  it('returns empty array when no entries', () => {
    expect(worker.entries.toArray()).toEqual([]);
  });

  it('maintains order across multiple wrap-arounds', () => {
    // Push 23 entries into capacity-5 buffer (wraps around ~4.6 times)
    for (let i = 0; i < 23; i++) {
      worker.send({ type: 'ENTRY', data: { id: `e-${i}` } });
    }

    const data = worker.entries.toArray();
    expect(data).toHaveLength(5);
    expect(data.map((d: any) => d.id)).toEqual(['e-18', 'e-19', 'e-20', 'e-21', 'e-22']);
  });

  it('resize down preserves most recent entries', () => {
    for (let i = 0; i < 5; i++) {
      worker.send({ type: 'ENTRY', data: { id: `e-${i}` } });
    }

    worker.send({ type: 'CONFIG', maxEntries: 2 });

    const data = worker.entries.toArray();
    expect(data).toHaveLength(2);
    expect(data.map((d: any) => d.id)).toEqual(['e-3', 'e-4']);
  });

  it('resize up preserves all existing entries', () => {
    worker.send({ type: 'CONFIG', maxEntries: 3 });
    for (let i = 0; i < 3; i++) {
      worker.send({ type: 'ENTRY', data: { id: `e-${i}` } });
    }

    worker.send({ type: 'CONFIG', maxEntries: 10 });

    const data = worker.entries.toArray();
    expect(data).toHaveLength(3);
    expect(data.map((d: any) => d.id)).toEqual(['e-0', 'e-1', 'e-2']);
  });

  it('clear then push works correctly', () => {
    for (let i = 0; i < 5; i++) {
      worker.send({ type: 'ENTRY', data: { id: `old-${i}` } });
    }

    worker.send({ type: 'CLEAR' });

    worker.send({ type: 'ENTRY', data: { id: 'new-0' } });
    worker.send({ type: 'ENTRY', data: { id: 'new-1' } });

    const data = worker.entries.toArray();
    expect(data).toHaveLength(2);
    expect(data.map((d: any) => d.id)).toEqual(['new-0', 'new-1']);
  });

  it('resize after wrap-around preserves correct entries', () => {
    // Fill and wrap around
    for (let i = 0; i < 8; i++) {
      worker.send({ type: 'ENTRY', data: { id: `e-${i}` } });
    }
    // Buffer has [e-3, e-4, e-5, e-6, e-7], head has wrapped

    worker.send({ type: 'CONFIG', maxEntries: 3 });

    const data = worker.entries.toArray();
    expect(data).toHaveLength(3);
    expect(data.map((d: any) => d.id)).toEqual(['e-5', 'e-6', 'e-7']);
  });
});

describe('Worker source (network ring buffer)', () => {
  let worker: ReturnType<typeof createMockWorker>;

  beforeEach(() => {
    worker = createMockWorker();
  });

  it('stores a network entry without sending a confirmation', () => {
    const entry = { url: '/api/data', method: 'GET', timestamp: 1 };
    worker.send({ type: 'NETWORK_ENTRY', data: entry });

    expect(worker.messages).toHaveLength(0);
    expect(worker.networkEntries.toArray()).toEqual([entry]);
  });

  it('stores multiple network entries in order', () => {
    worker.send({ type: 'NETWORK_ENTRY', data: { url: '/a' } });
    worker.send({ type: 'NETWORK_ENTRY', data: { url: '/b' } });

    const data = worker.networkEntries.toArray();
    expect(data).toHaveLength(2);
    expect(data[0].url).toBe('/a');
    expect(data[1].url).toBe('/b');
  });

  it('network entries have independent ring buffer from render entries', () => {
    worker.send({ type: 'CONFIG', maxEntries: 2 });

    // Fill render buffer
    worker.send({ type: 'ENTRY', data: { id: 'r1' } });
    worker.send({ type: 'ENTRY', data: { id: 'r2' } });
    worker.send({ type: 'ENTRY', data: { id: 'r3' } });

    // Fill network buffer independently
    worker.send({ type: 'NETWORK_ENTRY', data: { url: '/n1' } });
    worker.send({ type: 'NETWORK_ENTRY', data: { url: '/n2' } });
    worker.send({ type: 'NETWORK_ENTRY', data: { url: '/n3' } });

    const renderData = worker.entries.toArray();
    expect(renderData).toHaveLength(2);
    expect(renderData[0].id).toBe('r2');

    const networkData = worker.networkEntries.toArray();
    expect(networkData).toHaveLength(2);
    expect(networkData[0].url).toBe('/n2');
  });

  it('CLEAR empties both render and network entries', () => {
    worker.send({ type: 'ENTRY', data: { id: 'a' } });
    worker.send({ type: 'NETWORK_ENTRY', data: { url: '/b' } });

    worker.send({ type: 'CLEAR' });
    expect(worker.messages[0]).toEqual({ type: 'CLEARED' });

    expect(worker.entries.toArray()).toHaveLength(0);
    expect(worker.networkEntries.toArray()).toHaveLength(0);
  });
});

describe('Worker source (user event ring buffer)', () => {
  let worker: ReturnType<typeof createMockWorker>;

  beforeEach(() => {
    worker = createMockWorker();
  });

  it('stores a user event without sending a confirmation', () => {
    const entry = { type: 'click', timestamp: 1, target: { selector: 'button', tagName: 'button' } };
    worker.send({ type: 'USER_EVENT', data: entry });

    expect(worker.messages).toHaveLength(0);
    expect(worker.userEventEntries.toArray()).toEqual([entry]);
  });

  it('stores multiple user events in order', () => {
    worker.send({ type: 'USER_EVENT', data: { type: 'click', timestamp: 1 } });
    worker.send({ type: 'USER_EVENT', data: { type: 'input', timestamp: 2 } });

    const data = worker.userEventEntries.toArray();
    expect(data).toHaveLength(2);
    expect(data[0].type).toBe('click');
    expect(data[1].type).toBe('input');
  });

  it('CLEAR empties all three buffers', () => {
    worker.send({ type: 'ENTRY', data: { id: 'r1' } });
    worker.send({ type: 'NETWORK_ENTRY', data: { url: '/n1' } });
    worker.send({ type: 'USER_EVENT', data: { type: 'click', timestamp: 1 } });

    worker.send({ type: 'CLEAR' });
    expect(worker.messages[0]).toEqual({ type: 'CLEARED' });

    expect(worker.entries.toArray()).toHaveLength(0);
    expect(worker.networkEntries.toArray()).toHaveLength(0);
    expect(worker.userEventEntries.toArray()).toHaveLength(0);
  });
});

describe('createBridgeWorker fallback', () => {
  beforeEach(() => {
    (window as any).__RELENS__ = {
      version: 2,
      packageVersion: '0.0.0',
      renders: [],
      networks: [],
      userEvents: [],
    };
  });

  afterEach(() => {
    delete (window as any).__RELENS__;
  });

  it('isWorkerAvailable returns false in jsdom (fallback mode)', () => {
    const bridge = createBridgeWorker(100);
    expect(bridge.isWorkerAvailable()).toBe(false);
    bridge.terminate();
  });

  it('postEntry pushes to window.__RELENS__.renders', () => {
    const bridge = createBridgeWorker(100);
    const entry = { id: 'test', phase: 'mount', actualDuration: 1, baseDuration: 1, startTime: 0, commitTime: 0, timestamp: Date.now() } as RenderEntry;
    bridge.postEntry(entry);

    expect(window.__RELENS__!.renders).toHaveLength(1);
    expect(window.__RELENS__!.renders[0]).toBe(entry);
    bridge.terminate();
  });

  it('postNetworkEntry pushes to window.__RELENS__.networks', () => {
    const bridge = createBridgeWorker(100);
    const entry = { url: '/api', method: 'GET', status: 200, durationMs: 10, responseSize: null, initiator: 'fetch', timestamp: Date.now() } as NetworkEntry;
    bridge.postNetworkEntry(entry);

    expect(window.__RELENS__!.networks).toHaveLength(1);
    expect(window.__RELENS__!.networks[0]).toBe(entry);
    bridge.terminate();
  });

  it('postUserEvent pushes to window.__RELENS__.userEvents', () => {
    const bridge = createBridgeWorker(100);
    const entry = { type: 'click', timestamp: Date.now(), target: { selector: 'button', tagName: 'button' } } as UserEventEntry;
    bridge.postUserEvent(entry);

    expect(window.__RELENS__!.userEvents).toHaveLength(1);
    expect(window.__RELENS__!.userEvents[0]).toBe(entry);
    bridge.terminate();
  });

  it('postEntry dispatches __relens_render__ CustomEvent', () => {
    const bridge = createBridgeWorker(100);
    const events: RenderEntry[] = [];
    const handler = (e: Event) => {
      events.push((e as CustomEvent<RenderEntry>).detail);
    };
    window.addEventListener('__relens_render__', handler);

    const entry = { id: 'evt', phase: 'update', actualDuration: 2, baseDuration: 2, startTime: 0, commitTime: 0, timestamp: Date.now() } as RenderEntry;
    bridge.postEntry(entry);

    window.removeEventListener('__relens_render__', handler);
    bridge.terminate();

    expect(events).toHaveLength(1);
    expect(events[0]).toBe(entry);
  });

  it('ring buffer enforced in fallback mode', () => {
    const bridge = createBridgeWorker(3);
    for (let i = 0; i < 10; i++) {
      bridge.postEntry({ id: `e-${i}`, phase: 'mount', actualDuration: 1, baseDuration: 1, startTime: 0, commitTime: 0, timestamp: i } as RenderEntry);
    }

    // Push-then-splice keeps exactly maxEntries
    expect(window.__RELENS__!.renders).toHaveLength(3);
    // Oldest entries should be evicted — keeps the 3 most recent
    expect(window.__RELENS__!.renders[0].id).toBe('e-7');
    expect(window.__RELENS__!.renders[1].id).toBe('e-8');
    expect(window.__RELENS__!.renders[2].id).toBe('e-9');
    bridge.terminate();
  });

  it('terminate is safe to call and does not throw', () => {
    const bridge = createBridgeWorker(100);
    expect(() => bridge.terminate()).not.toThrow();
    // After terminate, postEntry still works via fallback
    bridge.postEntry({ id: 'after', phase: 'mount', actualDuration: 1, baseDuration: 1, startTime: 0, commitTime: 0, timestamp: Date.now() } as RenderEntry);
    // In fallback mode, terminate sets worker=null but fallback still writes to global
    // The entry may or may not appear depending on whether workerAvailable was already false
    // What matters is no error is thrown
  });
});
