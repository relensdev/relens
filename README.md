# @relensdev/relens

React performance telemetry for AI agents. Find, understand, fix, and verify optimizations — powered by runtime data, not guesswork.

## Install

```sh
npm install @relensdev/relens
# or
yarn add @relensdev/relens
```

## Quick Start

Wrap your app in `<RelensProvider>`:

```tsx
import { RelensProvider } from '@relensdev/relens';

function App() {
  return (
    <RelensProvider>
      <MyApp />
    </RelensProvider>
  );
}
```

That's it. Relens collects render timing, component re-renders, prop changes, effect firing patterns, and more — all accessible to AI agents via MCP tools.

## How It Works

Relens instruments your React app using the built-in Profiler API and fiber tree inspection to collect performance telemetry at runtime:

- Which components re-render and how long they take
- Which props changed to trigger each render
- Unnecessary re-renders (identical props)
- useEffect/useLayoutEffect firing patterns
- Network request timing (opt-in)
- User interaction traces (opt-in)

The data flows to the [Relens Chrome extension](https://relens.dev) for local inspection, and to AI agents (like Claude Code) via MCP for automated analysis and optimization suggestions.

## Configuration

All props are optional with sensible defaults.

```tsx
<RelensProvider
  instanceId="my-app"    // Routing key for multi-app setups
  id="default"           // Profiler ID (supports multiple providers)
  enabled={true}         // false = zero overhead, renders Fragment only
  maxEntries={2000}      // Ring buffer cap, oldest entries evicted
  sampleRate={1.0}       // 0.0-1.0, probability of recording each render
  filter={(name) => true} // Component name filter
  network={false}        // true = capture fetch/XHR metadata
  userEvents={false}     // true = capture user interactions
>
  <MyApp />
</RelensProvider>
```

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `instanceId` | `string` | — | Routing key for server-side data bucket |
| `id` | `string` | `"default"` | React Profiler ID |
| `enabled` | `boolean` | `true` | `false` removes Profiler entirely (zero overhead) |
| `maxEntries` | `number` | `2000` | Ring buffer size for render entries |
| `sampleRate` | `number` | `1.0` | Render recording probability (0.0-1.0) |
| `filter` | `(name: string) => boolean` | — | Filter which components are recorded |
| `network` | `boolean` | `false` | Capture fetch/XHR request metadata |
| `userEvents` | `boolean` | `false` | Capture user interactions (clicks, input, scroll) |

## Performance

Designed for zero perceptible impact on your app:

- Fiber walk runs synchronously during React's commit phase (~3-8ms) — necessary because fiber internals are mutable and would be corrupted if deferred
- Data processing runs in a Web Worker off the main thread
- `enabled={false}` is true zero overhead — no Profiler, no Worker
- Graceful fallback when Workers are unavailable (SSR, jsdom)

## AI Integration

Relens exposes 21 MCP tools that let AI agents query your app's runtime performance data directly. Set up the Chrome extension + MCP connection to enable AI-powered optimization workflows.

See the [setup guide](https://relens.dev/setup) for full instructions.

## Exports

```ts
// Component
import { RelensProvider } from '@relensdev/relens';

// Types
import type {
  RenderEntry,
  ComponentEntry,
  EffectInfo,
  NetworkEntry,
  UserEventEntry,
  RelensGlobal,
  RelensConfig,
  RelensProviderProps,
  RenderCause,
} from '@relensdev/relens';

// Version
import { VERSION } from '@relensdev/relens';
```

## Requirements

- React >= 18.0.0

## License

[MIT](./LICENSE)
