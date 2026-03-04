import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { RelensProvider } from '../provider.js';
import type { RelensGlobal } from '../types.js';
import { installNetworkInterceptor, uninstallNetworkInterceptor } from '../network-interceptor.js';
import { installUserEventCapture, uninstallUserEventCapture } from '../user-event-capture.js';

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

beforeEach(() => {
  delete window.__RELENS__;
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('Duplicate Provider ID Guard', () => {
  it('warns in dev when two providers share the same id', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <>
        <RelensProvider id="shared">
          <div>first</div>
        </RelensProvider>
        <RelensProvider id="shared">
          <div>second</div>
        </RelensProvider>
      </>
    );

    // useEffect runs after render, wait for registration
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    });

    // Verify the warning message mentions the duplicate id
    const warningCall = warnSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('id="shared"')
    );
    expect(warningCall).toBeDefined();
    expect(warningCall![0]).toContain('[Relens]');
    expect(warningCall![0]).toContain('refCount=2');

    warnSpy.mockRestore();
  });

  it('registry entry persists after first provider unmounts when duplicate exists', async () => {
    function First() {
      return (
        <RelensProvider id="shared">
          <div>first</div>
        </RelensProvider>
      );
    }

    function Second() {
      return (
        <RelensProvider id="shared">
          <div>second</div>
        </RelensProvider>
      );
    }

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { rerender } = render(
      <>
        <First />
        <Second />
      </>
    );

    // Wait for both providers to register
    await waitFor(() => {
      const providers = getGlobal()?.providers;
      expect(providers?.['shared']).toBeDefined();
      expect(providers?.['shared']?.refCount).toBe(2);
    });

    // Unmount the first provider by removing it from the tree
    rerender(
      <>
        <Second />
      </>
    );

    // Registry entry should still exist with refCount=1
    await waitFor(() => {
      const providers = getGlobal()?.providers;
      expect(providers?.['shared']).toBeDefined();
      expect(providers?.['shared']?.refCount).toBe(1);
    });

    warnSpy.mockRestore();
  });

  it('registry entry deleted only when all providers with same id unmount', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { unmount } = render(
      <>
        <RelensProvider id="shared">
          <div>first</div>
        </RelensProvider>
        <RelensProvider id="shared">
          <div>second</div>
        </RelensProvider>
      </>
    );

    // Wait for registration
    await waitFor(() => {
      const providers = getGlobal()?.providers;
      expect(providers?.['shared']).toBeDefined();
      expect(providers?.['shared']?.refCount).toBe(2);
    });

    // Unmount all
    unmount();

    // Registry entry should be fully removed
    const providers = getGlobal()?.providers;
    expect(providers?.['shared']).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('network interceptor uninstall called for each provider unmount', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { unmount } = render(
      <>
        <RelensProvider id="shared" network={true}>
          <div>first</div>
        </RelensProvider>
        <RelensProvider id="shared" network={true}>
          <div>second</div>
        </RelensProvider>
      </>
    );

    await waitFor(() => {
      expect(installNetworkInterceptor).toHaveBeenCalledTimes(2);
    });

    unmount();

    // Both providers should call uninstall
    expect(uninstallNetworkInterceptor).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it('user event capture uninstall called for each provider unmount', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { unmount } = render(
      <>
        <RelensProvider id="shared" userEvents={true}>
          <div>first</div>
        </RelensProvider>
        <RelensProvider id="shared" userEvents={true}>
          <div>second</div>
        </RelensProvider>
      </>
    );

    await waitFor(() => {
      expect(installUserEventCapture).toHaveBeenCalledTimes(2);
    });

    unmount();

    // Both providers should call uninstall
    expect(uninstallUserEventCapture).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
  });

  it('StrictMode does not produce false duplicate warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <StrictMode>
        <RelensProvider id="strict-test">
          <div>hello</div>
        </RelensProvider>
      </StrictMode>
    );

    // Give effects time to run (StrictMode runs mount, cleanup, mount)
    await new Promise((r) => setTimeout(r, 100));

    // StrictMode lifecycle: mount(refCount=1) -> cleanup(refCount=0, deleted) -> mount(refCount=1)
    // No duplicate warning should fire because cleanup resets to 0 before second mount
    const relensWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('[Relens]') && call[0].includes('id="strict-test"')
    );
    expect(relensWarnings).toHaveLength(0);

    // The entry should exist with refCount=1
    const providers = getGlobal()?.providers;
    expect(providers?.['strict-test']).toBeDefined();
    expect(providers?.['strict-test']?.refCount).toBe(1);

    warnSpy.mockRestore();
  });

  it('refCount field is set to 1 for a single provider', async () => {
    render(
      <RelensProvider id="single">
        <div>hello</div>
      </RelensProvider>
    );

    await waitFor(() => {
      const providers = getGlobal()?.providers;
      expect(providers?.['single']).toBeDefined();
    });

    const entry = getGlobal()!.providers!['single'];
    expect(entry.refCount).toBe(1);
  });

  it('providers with different ids do not trigger warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <>
        <RelensProvider id="alpha">
          <div>first</div>
        </RelensProvider>
        <RelensProvider id="beta">
          <div>second</div>
        </RelensProvider>
      </>
    );

    // Give effects time to run
    await new Promise((r) => setTimeout(r, 100));

    const relensWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('[Relens]')
    );
    expect(relensWarnings).toHaveLength(0);

    // Both entries should have refCount=1
    const providers = getGlobal()?.providers;
    expect(providers?.['alpha']?.refCount).toBe(1);
    expect(providers?.['beta']?.refCount).toBe(1);

    warnSpy.mockRestore();
  });
});

describe('Instance ID Mismatch Warning', () => {
  it('warns when two providers set different instanceIds', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <>
        <RelensProvider instanceId="app-one">
          <div>first</div>
        </RelensProvider>
        <RelensProvider instanceId="app-two">
          <div>second</div>
        </RelensProvider>
      </>
    );

    // The warning fires synchronously during render (not in useEffect),
    // because instanceId is written in the render body
    const mismatchWarnings = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('[Relens]') &&
        call[0].includes('conflicts with'),
    );
    expect(mismatchWarnings).toHaveLength(1);
    expect(mismatchWarnings[0][0]).toContain('instanceId="app-two"');
    expect(mismatchWarnings[0][0]).toContain('instanceId="app-one"');
    expect(mismatchWarnings[0][0]).toContain('Data will route to "app-two"');

    warnSpy.mockRestore();
  });

  it('does not warn when two providers use the same instanceId', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <>
        <RelensProvider instanceId="same-app">
          <div>first</div>
        </RelensProvider>
        <RelensProvider instanceId="same-app">
          <div>second</div>
        </RelensProvider>
      </>
    );

    const mismatchWarnings = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('[Relens]') &&
        call[0].includes('conflicts with'),
    );
    expect(mismatchWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it('does not warn when provider sets instanceId after default', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First provider has no instanceId (global stays "default" or undefined)
    // Second provider sets an explicit instanceId — should not warn
    render(
      <>
        <RelensProvider>
          <div>first</div>
        </RelensProvider>
        <RelensProvider instanceId="my-app">
          <div>second</div>
        </RelensProvider>
      </>
    );

    const mismatchWarnings = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('[Relens]') &&
        call[0].includes('conflicts with'),
    );
    expect(mismatchWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });

  it('does not warn under StrictMode with same instanceId', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    render(
      <StrictMode>
        <RelensProvider instanceId="strict-app">
          <div>hello</div>
        </RelensProvider>
      </StrictMode>
    );

    // StrictMode double-renders in dev, but instanceId stays the same
    // so no mismatch warning should fire
    const mismatchWarnings = warnSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('[Relens]') &&
        call[0].includes('conflicts with'),
    );
    expect(mismatchWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });
});
