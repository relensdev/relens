import type { ComponentEntry, RenderCause } from '../types.js';
import type { FiberNode } from './types.js';
import { COMPONENT_TAGS, MEMO_TAGS, PROFILER_TAG, HOST_COMPONENT_TAG, PERFORMED_WORK, MAX_FIBERS, MAX_HOOKS, MAX_CHILD_HOPS } from './types.js';
import { extractEffects } from './effects.js';
import { detectStateChange } from './state-detection.js';
import { getComponentName, sumChildComponentDurations, detectChangedProps } from './props-diff.js';

/**
 * Read the React fiber reference from a DOM node. React stores a back-pointer
 * from every committed host DOM node to its fiber via a private property keyed
 * `__reactFiber$<random>`. The suffix is randomized per React instance to
 * avoid collisions when multiple React roots share a page.
 *
 * IMPORTANT: React sets this property only during mount (precacheFiberNode in
 * completeWork) and never updates it. Due to double-buffering, the fiber
 * returned here may be on the alternate (non-current) tree on every other
 * commit. Callers must use `findProfilerFiber` which checks FiberRoot.current
 * to guarantee the returned Profiler fiber is on the committed tree.
 */
function getFiberFromNode(node: Element): FiberNode | null {
  const keys = Object.keys(node);
  // React 18+: __reactFiber$xxx, React 16-17: __reactInternalInstance$xxx
  const fiberKey = keys.find(
    (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
  );
  if (!fiberKey) return null;
  return (node as any)[fiberKey] as FiberNode;
}

function findProfilerFiber(fiber: FiberNode): FiberNode | null {
  let current: FiberNode | null = fiber;
  let profiler: FiberNode | null = null;
  let root: FiberNode | null = null;

  // Walk up the tree, recording the first Profiler and reaching the root.
  while (current) {
    if (current.tag === PROFILER_TAG && !profiler) {
      profiler = current;
    }
    root = current;
    current = current.return;
  }

  if (!profiler) return null;

  // Ensure we're on the current (committed) tree, not the alternate.
  // React sets __reactFiber$ on DOM nodes only during mount — it's never
  // updated. Due to double-buffering, the mount fiber alternates between
  // being current and alternate on each commit. On every other commit,
  // the DOM node points to the alternate tree. Walking up from an alternate
  // fiber reaches the alternate HostRoot. We detect this by checking
  // FiberRoot.current (the canonical source of truth for which tree is current).
  if (root && root.stateNode && root.stateNode.current !== root) {
    return profiler.alternate ?? profiler;
  }

  return profiler;
}

// React Compiler sentinel symbol
const MEMO_CACHE_SENTINEL = Symbol.for('react.memo_cache_sentinel');

const isBrowser = typeof window !== 'undefined';

/**
 * Walk down from a component fiber to find the first HostComponent (tag 5)
 * child with an HTMLElement stateNode. Returns null if not found or not in browser.
 */
export function resolveFiberToDOM(fiber: FiberNode): HTMLElement | null {
  if (!isBrowser) return null;
  let current: FiberNode | null = fiber;
  let hops = 0;
  while (current && hops < MAX_CHILD_HOPS) {
    if (current.tag === HOST_COMPONENT_TAG && current.stateNode instanceof HTMLElement) {
      return current.stateNode;
    }
    current = current.child;
    hops++;
  }
  return null;
}

export function isCompilerOptimized(fiber: FiberNode): boolean {
  // Check updateQueue.memoCache (React Compiler stores compiled cache here)
  if (fiber.updateQueue?.memoCache != null) return true;

  // Check memoizedState for sentinel symbol in the hooks linked list
  let hook = fiber.memoizedState;
  let count = 0;
  while (hook != null && count < MAX_HOOKS) {
    if (hook.memoizedState === MEMO_CACHE_SENTINEL) return true;
    // Check if it's an array containing the sentinel (compiler cache slots)
    if (Array.isArray(hook.memoizedState)) {
      for (const val of hook.memoizedState) {
        if (val === MEMO_CACHE_SENTINEL) return true;
      }
    }
    hook = hook.next;
    count++;
  }

  return false;
}

export function extractSourceLocation(
  fiber: FiberNode,
): { fileName: string; lineNumber: number } | undefined {
  // React 18: _debugSource has direct file/line info
  if (fiber._debugSource) {
    return {
      fileName: fiber._debugSource.fileName,
      lineNumber: fiber._debugSource.lineNumber,
    };
  }

  // React 19: _debugStack can be a string or an Error object
  if (fiber._debugStack) {
    const stackStr =
      typeof fiber._debugStack === 'string'
        ? fiber._debugStack
        : typeof fiber._debugStack === 'object' && 'stack' in (fiber._debugStack as object)
          ? (fiber._debugStack as Error).stack
          : undefined;
    if (stackStr) {
      return parseSourceFromStack(stackStr);
    }
  }

  return undefined;
}

export function parseSourceFromStack(
  stack: string,
): { fileName: string; lineNumber: number } | undefined {
  // Parse ALL matching frames, then pick the best one (first non-node_modules frame,
  // falling back to the first frame if all are in node_modules).

  // Chrome format: "at ComponentName (http://localhost:5173/src/Foo.tsx:15:3)"
  const chromeRe = /\bat\s+\S+\s+\((?:https?:\/\/[^/]+\/|webpack:\/\/\/)(.*?):(\d+):\d+\)/g;
  // Firefox/Safari format: "ComponentName@http://localhost:5173/src/Foo.tsx:15:3"
  const firefoxRe = /\S+@(?:https?:\/\/[^/]+\/|webpack:\/\/\/)(.*?):(\d+):\d+/g;

  const frames: { fileName: string; lineNumber: number }[] = [];

  let m: RegExpExecArray | null;
  while ((m = chromeRe.exec(stack)) !== null) {
    frames.push({ fileName: m[1], lineNumber: parseInt(m[2], 10) });
  }
  while ((m = firefoxRe.exec(stack)) !== null) {
    frames.push({ fileName: m[1], lineNumber: parseInt(m[2], 10) });
  }

  if (frames.length === 0) return undefined;

  // Prefer the first frame that isn't inside node_modules (i.e., app source code)
  const appFrame = frames.find((f) => !f.fileName.includes('node_modules'));
  return appFrame ?? frames[0];
}

export interface WalkResult {
  components: ComponentEntry[];
  rootCauseComponents: string[];
  /** Component name → DOM elements. Used by heatmap to skip its own fiber walk. */
  domElements: Map<string, HTMLElement[]>;
}

/**
 * Walk the committed React fiber tree under the Profiler and extract per-
 * component telemetry (timing, props/state changes, effects, render cause).
 *
 * Called synchronously from the Profiler's onRender callback during
 * commitLayoutEffects — this is the only safe time to read the fiber tree
 * because layout effects can trigger nested synchronous commits that would
 * mutate the tree under us.
 *
 * ## Filtering pipeline
 *
 * The walk applies three sequential filters to separate genuine render work
 * from noise (bailed-out fibers, stale current-tree fibers):
 *
 *   STALE CHECK  →  skips entire subtrees inherited from the current tree
 *                   (parent bailed out, cloneChildFibers was not called).
 *                   Uses `fiber.alternate.child === fiber.child` — React's
 *                   own didBailout signal in bubbleProperties.
 *        ↓
 *   LEVEL 1      →  prunes bailed-out COMPONENT subtrees where
 *                   actualDuration === 0 AND PerformedWork flag is unset.
 *                   Host fibers are never pruned here (React never sets
 *                   PerformedWork on them, and their actualDuration can be 0
 *                   even when children rendered).
 *        ↓
 *   LEVEL 2      →  excludes bailed-out component parents whose only
 *                   contribution is bubbled-up child duration (selfDuration=0).
 *                   We still traverse their children to find rendered descendants.
 *        ↓
 *   Component entry recorded
 *
 * ## Double-buffering safety
 *
 * The marker DOM node's __reactFiber$ can point to either the current or
 * alternate tree (React never updates it after mount). `findProfilerFiber`
 * detects and corrects this by checking FiberRoot.current.
 */
export function walkFiberTree(
  markerNode: Element | null,
): WalkResult | null {
  if (!markerNode) return null;

  try {
    const markerFiber = getFiberFromNode(markerNode);
    if (!markerFiber) return null;

    const profilerFiber = findProfilerFiber(markerFiber);
    if (!profilerFiber) return null;

    const components: ComponentEntry[] = [];
    const rootCauseComponents: string[] = [];
    const domElements = new Map<string, HTMLElement[]>();
    let visited = 0;

    // Iterative traversal: use a stack to avoid blowing the call stack
    // on wide trees (long sibling chains). Track depth for timeline flame chart.
    // The `stale` flag tracks whether a fiber is inherited from the current tree
    // (not cloned for this commit). Stale fibers and their subtrees are skipped.
    const stack: { fiber: FiberNode; depth: number; stale: boolean }[] = [];
    if (profilerFiber.child) {
      stack.push({ fiber: profilerFiber.child, depth: 0, stale: false });
    }

    while (stack.length > 0 && visited < MAX_FIBERS) {
      const { fiber, depth, stale } = stack.pop()!;
      visited++;

      // STALE DETECTION: Skip fibers inherited from the current tree.
      // When a fiber bails out, createWorkInProgress copies alternate.child
      // without calling cloneChildFibers. Those children are stale — they
      // belong to the previous commit and would produce ghost renders if
      // processed. Skip the entire subtree but continue to siblings (which
      // share the same staleness from their parent's bailout).
      if (stale) {
        if (fiber.sibling) stack.push({ fiber: fiber.sibling, depth, stale: true });
        continue;
      }

      const isComponent = COMPONENT_TAGS.has(fiber.tag);
      const hasAlternate = fiber.alternate !== null;
      const actualDuration = fiber.actualDuration ?? 0;

      // React's PerformedWork flag (bit 0) — true if this fiber completed
      // render work. Unlike actualDuration, this is a boolean that doesn't
      // suffer from performance.now() precision issues (100μs without
      // cross-origin isolation). Falls back to timing-only if flags unavailable.
      const hasWork = typeof fiber.flags === 'number'
        ? (fiber.flags & PERFORMED_WORK) !== 0
        : false;

      // LEVEL 1: Prune bailed-out component subtrees.
      // Only applies to component fibers — host fibers (div, span, etc.) are never
      // pruned because React never sets PerformedWork on them, and their
      // actualDuration can be 0 even when children rendered (bubbleProperties on
      // the bailout path doesn't accumulate children's durations). Pruning host
      // fibers would skip entire rendered subtrees nested under them.
      //
      // For component fibers: React resets actualDuration = 0 via
      // createWorkInProgress for all fibers that enter beginWork. If a component
      // bailed out AND none of its descendants rendered, actualDuration stays 0.
      // We check BOTH timing AND the PerformedWork flag — a component is only
      // pruned when both agree.
      if (isComponent && hasAlternate && actualDuration === 0 && !hasWork) {
        if (fiber.sibling) stack.push({ fiber: fiber.sibling, depth, stale });
        continue;
      }

      if (isComponent) {
        const childDurations = sumChildComponentDurations(fiber, 0);
        const selfDuration = Math.max(0, actualDuration - childDurations);

        // LEVEL 2: Only include components that did actual render work.
        // Bailed-out parents with rendered descendants have actualDuration > 0
        // (time bubbles up via completeWork) but selfDuration = 0. We traverse
        // their children to find the actual rendered descendants, but don't
        // include the parent itself — its alternate comparisons are unreliable.
        //
        // Also include if PerformedWork flag is set — this catches fast
        // components whose selfDuration rounds to 0.
        const isUpdate = hasAlternate;
        if (!isUpdate || selfDuration > 0 || hasWork) {
          const changedProps = isUpdate ? detectChangedProps(fiber) : [];
          const stateChanged = isUpdate ? detectStateChange(fiber) : false;
          const unnecessary = isUpdate && changedProps.length === 0 && !stateChanged;
          const effects = extractEffects(fiber);

          let renderCause: RenderCause;
          if (!isUpdate) {
            renderCause = 'mount';
          } else if (changedProps.length > 0 && stateChanged) {
            renderCause = 'props-and-state';
          } else if (stateChanged) {
            renderCause = 'state';
          } else if (changedProps.length > 0) {
            renderCause = 'props';
          } else {
            renderCause = 'parent';
          }

          const name = getComponentName(fiber);

          const entry: ComponentEntry = {
            name,
            selfDuration: Math.round(selfDuration * 100) / 100,
            actualDuration: Math.round(actualDuration * 100) / 100,
            phase: isUpdate ? 'update' : 'mount',
            unnecessary,
            changedProps,
            renderCause,
            depth,
          };
          if (effects) entry.effects = effects;
          if (MEMO_TAGS.has(fiber.tag)) entry.isMemoized = true;
          if (isCompilerOptimized(fiber)) entry.isCompilerOptimized = true;
          const source = extractSourceLocation(fiber);
          if (source) entry.source = source;

          components.push(entry);

          // Resolve component fiber to its first host DOM element.
          // Included in the WalkResult so the heatmap overlay can map
          // components to DOM rects without its own redundant fiber walk.
          const domNode = resolveFiberToDOM(fiber);
          if (domNode) {
            const list = domElements.get(name);
            if (list) {
              list.push(domNode);
            } else {
              domElements.set(name, [domNode]);
            }
          }

          // Root cause: components that triggered their own re-render (state or props-and-state)
          if (renderCause === 'state' || renderCause === 'props-and-state') {
            rootCauseComponents.push(name);
          }
        }
      }

      // Push sibling first, then child — child is processed first (LIFO)
      // Siblings share the same depth; children go one level deeper.
      // Only increment depth for component nodes (non-component wrappers like
      // HostRoot, HostComponent, etc. are transparent in the flame chart).
      const childDepth = isComponent ? depth + 1 : depth;
      if (fiber.sibling) {
        stack.push({ fiber: fiber.sibling, depth, stale });
      }
      if (fiber.child) {
        // Detect stale children: if this fiber's alternate has the same .child
        // pointer, cloneChildFibers was NOT called — children are inherited from
        // the previous commit (stale). This mirrors React's own didBailout check
        // in bubbleProperties. Immune to fiber double-buffering.
        const childrenInherited = fiber.alternate != null && fiber.alternate.child === fiber.child;
        stack.push({ fiber: fiber.child, depth: childDepth, stale: childrenInherited });
      }
    }

    return { components, rootCauseComponents, domElements };
  } catch {
    return null;
  }
}
