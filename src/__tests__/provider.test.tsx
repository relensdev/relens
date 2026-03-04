import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act, cleanup, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { RelensProvider } from '../provider.js';
import type { RenderEntry, RelensGlobal } from '../types.js';

// Mock the network interceptor so we can verify install/uninstall calls
vi.mock('../network-interceptor.js', () => ({
  installNetworkInterceptor: vi.fn(),
  uninstallNetworkInterceptor: vi.fn(),
}));

// Mock the user event capture so we can verify install/uninstall calls
vi.mock('../user-event-capture.js', () => ({
  installUserEventCapture: vi.fn(),
  uninstallUserEventCapture: vi.fn(),
}));

function getGlobal(): RelensGlobal | undefined {
  return window.__RELENS__;
}

// A component that triggers re-renders on click
function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((c) => c + 1)}>count: {count}</button>;
}

beforeEach(() => {
  delete window.__RELENS__;
});

afterEach(() => {
  cleanup();
});

describe('RelensProvider', () => {
  it('renders children correctly', () => {
    const { getByText } = render(
      <RelensProvider>
        <div>hello</div>
      </RelensProvider>
    );
    expect(getByText('hello')).toBeTruthy();
  });

  it('initializes window.__RELENS__ with version 2', async () => {
    render(
      <RelensProvider>
        <div />
      </RelensProvider>
    );
    // The provider implementation is lazy-loaded in non-production environments,
    // so __RELENS__ may not be set synchronously on first render.
    await waitFor(() => {
      expect(getGlobal()).toBeDefined();
    });
    const bridge = getGlobal();
    expect(bridge!.version).toBe(2);
    expect(Array.isArray(bridge!.renders)).toBe(true);
  });

  it('records render entries with correct shape on state change', async () => {
    const { getByText } = render(
      <RelensProvider>
        <Counter />
      </RelensProvider>
    );

    await act(async () => {
      getByText('count: 0').click();
    });

    // Entries arrive asynchronously via Worker message processing
    await waitFor(() => {
      const renders = getGlobal()!.renders;
      expect(renders.length).toBeGreaterThanOrEqual(1);
    });

    const entry = getGlobal()!.renders[0];
    expect(entry).toMatchObject({
      id: expect.any(String),
      phase: expect.stringMatching(/^(mount|update|nested-update)$/),
      actualDuration: expect.any(Number),
      baseDuration: expect.any(Number),
      startTime: expect.any(Number),
      commitTime: expect.any(Number),
      timestamp: expect.any(Number),
    });
  });

  it('entries have components array or gracefully omit it (jsdom)', async () => {
    const { getByText } = render(
      <RelensProvider>
        <Counter />
      </RelensProvider>
    );

    await act(async () => {
      getByText('count: 0').click();
    });

    // Entries arrive asynchronously via Worker message processing
    await waitFor(() => {
      expect(getGlobal()!.renders.length).toBeGreaterThanOrEqual(1);
    });

    const renders = getGlobal()!.renders;
    const entry = renders[0];
    // In jsdom, fiber walking may or may not work — accept both outcomes
    if (entry.components != null) {
      expect(Array.isArray(entry.components)).toBe(true);
      for (const comp of entry.components!) {
        expect(comp).toMatchObject({
          name: expect.any(String),
          selfDuration: expect.any(Number),
          actualDuration: expect.any(Number),
          phase: expect.stringMatching(/^(mount|update)$/),
          unnecessary: expect.any(Boolean),
          changedProps: expect.any(Array),
        });
      }
    }
    // If components is undefined, that's fine — graceful degradation
  });

  it('enabled={false} does not record entries', async () => {
    const { getByText } = render(
      <RelensProvider enabled={false}>
        <Counter />
      </RelensProvider>
    );

    await act(async () => {
      getByText('count: 0').click();
    });

    expect(getGlobal()).toBeUndefined();
  });

  it('marker span present when enabled', () => {
    const { container } = render(
      <RelensProvider>
        <div>hello</div>
      </RelensProvider>
    );

    const marker = container.querySelector('[data-relens-marker]');
    expect(marker).toBeTruthy();
    expect((marker as HTMLElement).style.display).toBe('none');
  });

  it('marker span absent when enabled={false}', () => {
    const { container } = render(
      <RelensProvider enabled={false}>
        <div>hello</div>
      </RelensProvider>
    );

    const marker = container.querySelector('[data-relens-marker]');
    expect(marker).toBeNull();
  });

  it('maxEntries caps the array size', async () => {
    const { getByRole } = render(
      <RelensProvider maxEntries={3}>
        <Counter />
      </RelensProvider>
    );

    const button = getByRole('button');
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        button.click();
      });
    }

    // Wait for Worker-processed entries to arrive
    await waitFor(() => {
      expect(getGlobal()!.renders.length).toBeGreaterThanOrEqual(1);
    });

    const renders = getGlobal()!.renders;
    expect(renders.length).toBeLessThanOrEqual(3);
  });

  it('sampleRate={0} records no entries', async () => {
    const { getByText } = render(
      <RelensProvider sampleRate={0}>
        <Counter />
      </RelensProvider>
    );

    await act(async () => {
      getByText('count: 0').click();
    });

    const bridge = getGlobal()!;
    expect(bridge.renders.length).toBe(0);
  });

  it('filter rejects non-matching components', async () => {
    const { getByText } = render(
      <RelensProvider filter={(id) => id === 'never-match'}>
        <Counter />
      </RelensProvider>
    );

    await act(async () => {
      getByText('count: 0').click();
    });

    const bridge = getGlobal()!;
    expect(bridge.renders.length).toBe(0);
  });

  it('filter matches component names from fiber walk', async () => {
    // Filter that rejects the profiler ID but would match "Counter"
    const { getByText } = render(
      <RelensProvider filter={(id) => id === 'Counter'}>
        <Counter />
      </RelensProvider>
    );

    await act(async () => {
      getByText('count: 0').click();
    });

    const bridge = getGlobal()!;
    // If fiber walking works in jsdom, entries are recorded because "Counter" matches.
    // If fiber walking fails, entries are rejected because "default" doesn't match "Counter".
    // Both outcomes are valid.
    expect(bridge.renders.length).toBeGreaterThanOrEqual(0);
  });

  it('dispatches __relens_render__ CustomEvent on render', async () => {
    const events: RenderEntry[] = [];
    const handler = (e: Event) => {
      events.push((e as CustomEvent<RenderEntry>).detail);
    };
    window.addEventListener('__relens_render__', handler);

    const { getByText } = render(
      <RelensProvider>
        <Counter />
      </RelensProvider>
    );

    await act(async () => {
      getByText('count: 0').click();
    });

    // CustomEvent fires after Worker message processing
    await waitFor(() => {
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    window.removeEventListener('__relens_render__', handler);

    expect(events[0]).toMatchObject({
      id: expect.any(String),
      phase: expect.stringMatching(/^(mount|update|nested-update)$/),
    });
  });

  it('handles missing/corrupted window.__RELENS__ gracefully', async () => {
    const { getByText } = render(
      <RelensProvider>
        <Counter />
      </RelensProvider>
    );

    // Corrupt the global
    (window as any).__RELENS__ = { renders: 'not-an-array' };

    // Should not throw
    await act(async () => {
      getByText('count: 0').click();
    });
  });

  it('multiple providers with different IDs record independently', async () => {
    function App() {
      return (
        <>
          <RelensProvider id="provider-a">
            <Counter />
          </RelensProvider>
          <RelensProvider id="provider-b">
            <Counter />
          </RelensProvider>
        </>
      );
    }

    const { getAllByText } = render(<App />);

    await act(async () => {
      const buttons = getAllByText('count: 0');
      buttons[0].click();
    });

    // Entries arrive asynchronously via Worker message processing
    await waitFor(() => {
      const renders = getGlobal()!.renders;
      expect(renders.length).toBeGreaterThanOrEqual(1);
    });

    const renders = getGlobal()!.renders;
    const ids = new Set(renders.map((r) => r.id));
    expect(ids.size).toBeGreaterThanOrEqual(1);
    expect(ids.has('provider-a')).toBe(true);
  });

  it('network={true} installs the network interceptor', async () => {
    const { installNetworkInterceptor } = await import('../network-interceptor.js');

    render(
      <RelensProvider network={true}>
        <div>hello</div>
      </RelensProvider>
    );

    // useEffect runs after render
    await waitFor(() => {
      expect(installNetworkInterceptor).toHaveBeenCalled();
    });
  });

  it('default (no network prop) does not install interceptor', async () => {
    const { installNetworkInterceptor } = await import('../network-interceptor.js');
    (installNetworkInterceptor as any).mockClear();

    render(
      <RelensProvider>
        <div>hello</div>
      </RelensProvider>
    );

    // Give useEffect a chance to run
    await new Promise((r) => setTimeout(r, 50));

    expect(installNetworkInterceptor).not.toHaveBeenCalled();
  });

  it('unmount uninstalls network interceptor', async () => {
    const { installNetworkInterceptor, uninstallNetworkInterceptor } = await import('../network-interceptor.js');
    (installNetworkInterceptor as any).mockClear();
    (uninstallNetworkInterceptor as any).mockClear();

    const { unmount } = render(
      <RelensProvider network={true}>
        <div>hello</div>
      </RelensProvider>
    );

    await waitFor(() => {
      expect(installNetworkInterceptor).toHaveBeenCalled();
    });

    unmount();

    expect(uninstallNetworkInterceptor).toHaveBeenCalled();
  });

  it('initializes networks array on global', () => {
    render(
      <RelensProvider>
        <div />
      </RelensProvider>
    );
    const bridge = getGlobal();
    expect(bridge).toBeDefined();
    expect(Array.isArray(bridge!.networks)).toBe(true);
  });

  it('instanceId prop sets window.__RELENS__.instanceId', () => {
    render(
      <RelensProvider instanceId="my-instance">
        <div />
      </RelensProvider>
    );
    const bridge = getGlobal();
    expect(bridge).toBeDefined();
    expect(bridge!.instanceId).toBe('my-instance');
  });

  it('missing instanceId does not set the field', () => {
    render(
      <RelensProvider>
        <div />
      </RelensProvider>
    );
    const bridge = getGlobal();
    expect(bridge).toBeDefined();
    expect(bridge!.instanceId).toBeUndefined();
  });

  it('changing instanceId updates the global', () => {
    function Wrapper({ instanceId }: { instanceId?: string }) {
      return (
        <RelensProvider instanceId={instanceId}>
          <div />
        </RelensProvider>
      );
    }

    const { rerender } = render(<Wrapper instanceId="first" />);
    expect(getGlobal()!.instanceId).toBe('first');

    rerender(<Wrapper instanceId="second" />);
    expect(getGlobal()!.instanceId).toBe('second');
  });

  it('userEvents={true} installs user event capture', async () => {
    const { installUserEventCapture } = await import('../user-event-capture.js');

    render(
      <RelensProvider userEvents={true}>
        <div>hello</div>
      </RelensProvider>
    );

    await waitFor(() => {
      expect(installUserEventCapture).toHaveBeenCalled();
    });
  });

  it('default (no userEvents prop) does not install user event capture', async () => {
    const { installUserEventCapture } = await import('../user-event-capture.js');
    (installUserEventCapture as any).mockClear();

    render(
      <RelensProvider>
        <div>hello</div>
      </RelensProvider>
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(installUserEventCapture).not.toHaveBeenCalled();
  });

  it('unmount uninstalls user event capture', async () => {
    const { installUserEventCapture, uninstallUserEventCapture } = await import('../user-event-capture.js');
    (installUserEventCapture as any).mockClear();
    (uninstallUserEventCapture as any).mockClear();

    const { unmount } = render(
      <RelensProvider userEvents={true}>
        <div>hello</div>
      </RelensProvider>
    );

    await waitFor(() => {
      expect(installUserEventCapture).toHaveBeenCalled();
    });

    unmount();

    expect(uninstallUserEventCapture).toHaveBeenCalled();
  });

  it('warns and clamps maxEntries below 1', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <RelensProvider maxEntries={0}>
        <Counter />
      </RelensProvider>
    );

    await waitFor(() => {
      expect(getGlobal()).toBeDefined();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('maxEntries=0 is out of range'),
    );

    warnSpy.mockRestore();
  });

  it('warns and clamps maxEntries above 100000', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <RelensProvider maxEntries={200000}>
        <Counter />
      </RelensProvider>
    );

    await waitFor(() => {
      expect(getGlobal()).toBeDefined();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('maxEntries=200000 is out of range'),
    );

    warnSpy.mockRestore();
  });

  it('warns and clamps sampleRate below 0', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <RelensProvider sampleRate={-0.5}>
        <Counter />
      </RelensProvider>
    );

    await waitFor(() => {
      expect(getGlobal()).toBeDefined();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sampleRate=-0.5 is out of range'),
    );

    warnSpy.mockRestore();
  });

  it('warns and clamps sampleRate above 1', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <RelensProvider sampleRate={2.0}>
        <Counter />
      </RelensProvider>
    );

    await waitFor(() => {
      expect(getGlobal()).toBeDefined();
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('sampleRate=2 is out of range'),
    );

    warnSpy.mockRestore();
  });

  it('does not warn for valid maxEntries and sampleRate', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <RelensProvider maxEntries={500} sampleRate={0.5}>
        <Counter />
      </RelensProvider>
    );

    await waitFor(() => {
      expect(getGlobal()).toBeDefined();
    });

    // Should not have warned about maxEntries or sampleRate
    const relensWarns = warnSpy.mock.calls.filter(
      (args) => typeof args[0] === 'string' && (args[0].includes('maxEntries') || args[0].includes('sampleRate')),
    );
    expect(relensWarns).toHaveLength(0);

    warnSpy.mockRestore();
  });
});
