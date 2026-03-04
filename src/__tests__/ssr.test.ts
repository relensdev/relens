import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { RelensProvider } from '../provider.js';

describe('SSR compatibility', () => {
  it('renderToString renders children without crashing', () => {
    const html = renderToString(
      createElement(
        RelensProvider,
        { instanceId: 'ssr-test' },
        createElement('div', { 'data-testid': 'child' }, 'hello'),
      ),
    );

    expect(html).toContain('hello');
    expect(html).toContain('data-testid="child"');
  });

  it('renderToString with enabled={false} renders children', () => {
    const html = renderToString(
      createElement(
        RelensProvider,
        { instanceId: 'ssr-test', enabled: false },
        createElement('span', null, 'disabled'),
      ),
    );

    expect(html).toContain('disabled');
  });

  it('renderToString with all optional props', () => {
    const html = renderToString(
      createElement(
        RelensProvider,
        {
          instanceId: 'ssr-full',
          enabled: true,
          network: true,
          userEvents: true,
          maxEntries: 500,
          sampleRate: 0.5,
        },
        createElement('p', null, 'full props'),
      ),
    );

    expect(html).toContain('full props');
  });

  it('renderToString with no children does not crash', () => {
    const html = renderToString(
      createElement(RelensProvider, { instanceId: 'ssr-empty' }),
    );

    expect(typeof html).toBe('string');
  });
});
