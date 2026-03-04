/** Why a component re-rendered: mount, own state change, props change, both, or forced by parent. */
export type RenderCause = 'mount' | 'state' | 'props' | 'props-and-state' | 'parent';

/**
 * Controls how much of captured network URLs is visible to downstream consumers
 * (extension DevTools, server, MCP tools). Applied at capture time in the
 * network interceptor — the raw URL never enters the pipeline.
 *
 * - `'none'` — No redaction. Full URL preserved (default, current behavior).
 * - `'host'` — Strip scheme and host, keep pathname. E.g. `https://api.example.com/v1/users` becomes `/v1/users`.
 * - `'path'` — Keep origin only, strip pathname. E.g. `https://api.example.com/v1/users` becomes `https://api.example.com`.
 * - `'full'` — Replace entire URL with a deterministic hash (`net_` prefix + 8 hex chars). Same URL always produces the same hash.
 */
export type UrlRedaction = 'none' | 'host' | 'path' | 'full';

/** Information about a single useEffect or useLayoutEffect hook in a component. */
export interface EffectInfo {
  /** Whether this is a `useEffect` or `useLayoutEffect`. */
  type: 'useEffect' | 'useLayoutEffect';
  /** `true` if deps changed and the effect will fire this commit. */
  fired: boolean;
  /** Number of dependencies, or `null` if no deps array (fires every render). */
  depsCount: number | null;
  /** `true` if the effect has a cleanup function. */
  hasCleanup: boolean;
  /** Position in the component's effect list (stable across renders). */
  index: number;
}

/** Per-component data from a single render commit. */
export interface ComponentEntry {
  /** Component display name (or "Anonymous" / "Unknown"). */
  name: string;
  /** Time spent in this component only, excluding children (ms). */
  selfDuration: number;
  /** Total render time including children (ms). */
  actualDuration: number;
  /** Whether this was the component's first render or a re-render. */
  phase: 'mount' | 'update';
  /** `true` if props and state were unchanged — a wasted re-render. */
  unnecessary: boolean;
  /** Prop keys whose values changed (by reference) since the previous render. */
  changedProps: string[];
  /** Classification of what triggered this render. */
  renderCause?: RenderCause;
  /** Effect hooks in this component. Only present for function components with hooks. */
  effects?: EffectInfo[];
  /** Tree depth from the Profiler root (for flame chart visualization). */
  depth?: number;
  /** `true` if the component is wrapped in `React.memo()`. */
  isMemoized?: boolean;
  /** `true` if the component is optimized by React Compiler. */
  isCompilerOptimized?: boolean;
  /** Source file location (dev builds only). */
  source?: { fileName: string; lineNumber: number };
}

/** A single render commit captured by the Profiler. */
export interface RenderEntry {
  /** Profiler ID (the `id` prop on `<RelensProvider>`). */
  id: string;
  /** Render phase: initial mount, update, or nested update (setState during render). */
  phase: 'mount' | 'update' | 'nested-update';
  /** Total render time for the committed tree (ms). */
  actualDuration: number;
  /** Estimated time for a full re-render of the subtree (ms). */
  baseDuration: number;
  /** When React began rendering this update (ms, relative to page load). */
  startTime: number;
  /** When React committed this update (ms, relative to page load). */
  commitTime: number;
  /** Wall-clock timestamp (ms since epoch). */
  timestamp: number;
  /** Per-component breakdown. Absent if fiber walking is unavailable. */
  components?: ComponentEntry[];
  /** Components that triggered re-renders via state changes (root causes). */
  rootCauseComponents?: string[];
}

/** A captured network request (fetch or XHR). */
export interface NetworkEntry {
  /** Request URL (query parameters stripped by default for privacy). */
  url: string;
  /** HTTP method (GET, POST, etc.). */
  method: string;
  /** HTTP status code, or `null` on network error. */
  status: number | null;
  /** Request duration in milliseconds. */
  durationMs: number;
  /** Response size from Content-Length header, or `null` if unavailable. */
  responseSize: number | null;
  /** Whether the request was made via `fetch()` or `XMLHttpRequest`. */
  initiator: 'fetch' | 'xhr';
  /** Wall-clock timestamp (ms since epoch). */
  timestamp: number;
  /** Error message if the request failed. */
  error?: string;
}

/** A captured user interaction event. Privacy-aware: no input values, no passwords. */
export interface UserEventEntry {
  /** The type of DOM event. */
  type: 'click' | 'input' | 'keydown' | 'scroll' | 'submit' | 'focus' | 'blur';
  /** Wall-clock timestamp (ms since epoch). */
  timestamp: number;
  /** Information about the event target element. */
  target: {
    /** CSS selector for the target element. */
    selector: string;
    /** Lowercase tag name of the target element. */
    tagName: string;
    /** Visible text content (truncated to 80 chars). */
    textContent?: string;
    /** Input type attribute (e.g., "text", "email", "textarea"). */
    inputType?: string;
    /** `data-testid` attribute value, if present. */
    testId?: string;
    /** `aria-label` attribute value, if present. */
    ariaLabel?: string;
    /** `name` attribute value, if present. */
    name?: string;
  };
  /** Key name for keydown events (only special keys: Enter, Escape, Tab, arrows, etc.). */
  key?: string;
  /** Length of the input value (actual value is never captured). */
  valueLength?: number;
  /** Horizontal scroll position (for scroll events). */
  scrollX?: number;
  /** Vertical scroll position (for scroll events). */
  scrollY?: number;
}

/** Frozen snapshot of the provider configuration, exposed on `window.__RELENS__`. */
export interface RelensConfigSnapshot {
  instanceId?: string;
  network: boolean;
  userEvents: boolean;
  sampleRate: number;
  maxEntries: number;
}

/** Per-provider entry in the provider registry on `window.__RELENS__`. */
export interface ProviderRegistryEntry {
  config: Omit<RelensConfigSnapshot, 'instanceId'>;
  /** Number of active `<RelensProvider>` instances sharing this profile ID. */
  refCount: number;
}

/** Shape of the `window.__RELENS__` global object used for browser-extension communication. */
export interface RelensGlobal {
  version: 1 | 2;
  packageVersion?: string;
  renders: RenderEntry[];
  networks: NetworkEntry[];
  userEvents: UserEventEntry[];
  instanceId?: string;
  /** Registry of active providers keyed by profileId (the `id` prop on RelensProvider). */
  providers?: Record<string, ProviderRegistryEntry>;
}

/** Configuration props for `<RelensProvider>`. All are optional with sensible defaults. */
export interface RelensConfig {
  /** Set to `false` to completely disable instrumentation (zero overhead). */
  enabled?: boolean;
  /** Ring buffer size for render entries. Oldest entries are evicted. @default 2000 */
  maxEntries?: number;
  /** Probability (0.0-1.0) of recording each render commit. @default 1.0 */
  sampleRate?: number;
  /** Filter function — return `false` to exclude a component by name. */
  filter?: (componentId: string) => boolean;
  /** Capture fetch/XHR request metadata. @default false */
  network?: boolean;
  /**
   * Custom URL sanitizer for network telemetry. Receives the raw URL and should
   * return a sanitized version. By default, query parameters are stripped
   * (`url.split('?')[0]`) to prevent leaking tokens, API keys, or PII.
   *
   * Pass a custom function to control exactly what is captured:
   * - Return the URL as-is to preserve query parameters
   * - Return a redacted version to mask sensitive path segments
   *
   * @example
   * ```tsx
   * // Keep query params (opt out of default stripping)
   * <RelensProvider network sanitizeUrl={(url) => url}>
   *
   * // Redact specific params
   * <RelensProvider network sanitizeUrl={(url) => {
   *   const u = new URL(url);
   *   u.searchParams.delete('token');
   *   return u.toString();
   * }}>
   * ```
   */
  sanitizeUrl?: (url: string) => string;
  /**
   * Controls how much of captured network URLs is visible to downstream
   * consumers (extension, server, MCP tools). Query parameters are always
   * stripped regardless of level.
   *
   * - `'none'` (default) — Full URL preserved.
   * - `'host'` — Strip scheme+host, keep pathname (e.g. `/v1/users`).
   * - `'path'` — Keep origin only (e.g. `https://api.example.com`).
   * - `'full'` — Deterministic hash (`net_` + 8 hex chars).
   *
   * If `sanitizeUrl` is also provided, it runs first, then `urlRedaction`
   * applies on top.
   *
   * @default 'none'
   */
  urlRedaction?: UrlRedaction;
  /** Capture user interaction events (clicks, input, scroll, etc.). @default false */
  userEvents?: boolean;
  /** Routing key that links this app to an MCP endpoint on the server. */
  instanceId?: string;
}

/** Props for the {@link RelensProvider} component. */
export interface RelensProviderProps extends RelensConfig {
  /** The React subtree to instrument. */
  children: import('react').ReactNode;
  /** React Profiler ID. Useful when using multiple providers. */
  id?: string;
}

declare global {
  interface Window {
    __RELENS__?: RelensGlobal;
  }
}
