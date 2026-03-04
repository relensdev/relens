import { describe, it, expect } from 'vitest';
import { walkFiberTree, resolveFiberToDOM, extractEffects, detectStateChange, isCompilerOptimized, extractSourceLocation, parseSourceFromStack } from '../fiber-walker/index.js';
import { getComponentName, detectChangedProps, sumChildComponentDurations } from '../fiber-walker/props-diff.js';
import { PROFILER_TAG, FUNCTION_COMPONENT, CLASS_COMPONENT, SIMPLE_MEMO_COMPONENT, MEMO_COMPONENT, FORWARD_REF, MAX_FIBERS, MAX_CHILD_HOPS, PERFORMED_WORK } from '../fiber-walker/types.js';
import type { FiberNode } from '../fiber-walker/types.js';

describe('walkFiberTree', () => {
  it('returns null for null input', () => {
    expect(walkFiberTree(null)).toBeNull();
  });

  it('returns null for a plain DOM element with no fiber', () => {
    const div = document.createElement('div');
    expect(walkFiberTree(div)).toBeNull();
  });
});

describe('extractEffects', () => {
  // Helper: build a circular linked list of effects
  function makeEffectList(effects: Array<{ tag: number; deps: any; destroy: any }>) {
    if (effects.length === 0) return null;
    const nodes = effects.map((e) => ({ ...e, next: null as any }));
    for (let i = 0; i < nodes.length - 1; i++) {
      nodes[i].next = nodes[i + 1];
    }
    nodes[nodes.length - 1].next = nodes[0]; // circular
    return nodes[nodes.length - 1]; // lastEffect points to the last node
  }

  it('returns null when updateQueue is null', () => {
    const fiber = { tag: 0, updateQueue: null };
    expect(extractEffects(fiber)).toBeNull();
  });

  it('returns null when updateQueue has no lastEffect', () => {
    const fiber = { tag: 0, updateQueue: { shared: {} } };
    expect(extractEffects(fiber)).toBeNull();
  });

  it('returns null for class components (tag 1)', () => {
    const lastEffect = makeEffectList([{ tag: 9, deps: [], destroy: undefined }]);
    const fiber = { tag: 1, updateQueue: { lastEffect } };
    expect(extractEffects(fiber)).toBeNull();
  });

  it('extracts a single useEffect that fired', () => {
    // tag: HAS_EFFECT(1) | PASSIVE(8) = 9
    const lastEffect = makeEffectList([{ tag: 9, deps: [1, 2], destroy: undefined }]);
    const fiber = { tag: 0, updateQueue: { lastEffect } };
    const result = extractEffects(fiber);
    expect(result).toEqual([
      { type: 'useEffect', fired: true, depsCount: 2, hasCleanup: false, index: 0 },
    ]);
  });

  it('extracts a useLayoutEffect with cleanup', () => {
    // tag: HAS_EFFECT(1) | LAYOUT(4) = 5
    const lastEffect = makeEffectList([{ tag: 5, deps: [], destroy: () => {} }]);
    const fiber = { tag: 0, updateQueue: { lastEffect } };
    const result = extractEffects(fiber);
    expect(result).toEqual([
      { type: 'useLayoutEffect', fired: true, depsCount: 0, hasCleanup: true, index: 0 },
    ]);
  });

  it('extracts multiple effects with different types', () => {
    const lastEffect = makeEffectList([
      { tag: 9, deps: [], destroy: () => {} },        // useEffect, fired, cleanup, 0 deps
      { tag: 8, deps: [1], destroy: undefined },       // useEffect, NOT fired, 1 dep
      { tag: 5, deps: null, destroy: undefined },       // useLayoutEffect, fired, no deps array
    ]);
    const fiber = { tag: 0, updateQueue: { lastEffect } };
    const result = extractEffects(fiber);
    expect(result).toHaveLength(3);
    expect(result![0]).toEqual({ type: 'useEffect', fired: true, depsCount: 0, hasCleanup: true, index: 0 });
    expect(result![1]).toEqual({ type: 'useEffect', fired: false, depsCount: 1, hasCleanup: false, index: 1 });
    expect(result![2]).toEqual({ type: 'useLayoutEffect', fired: true, depsCount: null, hasCleanup: false, index: 2 });
  });

  it('handles idle effects (not fired this commit)', () => {
    // tag: PASSIVE(8) only, no HAS_EFFECT bit
    const lastEffect = makeEffectList([{ tag: 8, deps: [1, 2, 3], destroy: () => {} }]);
    const fiber = { tag: 0, updateQueue: { lastEffect } };
    const result = extractEffects(fiber);
    expect(result).toEqual([
      { type: 'useEffect', fired: false, depsCount: 3, hasCleanup: true, index: 0 },
    ]);
  });

  it('caps at MAX_EFFECTS to prevent infinite loops', () => {
    // Create a list of 60 effects — should be capped at 50
    const effects = Array.from({ length: 60 }, () => ({ tag: 9, deps: [], destroy: undefined }));
    const lastEffect = makeEffectList(effects);
    const fiber = { tag: 0, updateQueue: { lastEffect } };
    const result = extractEffects(fiber);
    expect(result!.length).toBeLessThanOrEqual(50);
  });
});

describe('detectStateChange', () => {
  // Helper: build a hooks linked list (useState/useReducer hooks have queue != null)
  function makeHooksList(hooks: Array<{ memoizedState: any; queue: any }>) {
    if (hooks.length === 0) return null;
    const nodes = hooks.map((h) => ({ ...h, next: null as any }));
    for (let i = 0; i < nodes.length - 1; i++) {
      nodes[i].next = nodes[i + 1];
    }
    return nodes[0]; // head of linked list
  }

  it('returns false for mount (no alternate)', () => {
    const fiber = { tag: 0, memoizedState: null, alternate: null };
    expect(detectStateChange(fiber)).toBe(false);
  });

  it('detects function component state change (useState)', () => {
    const stateA = { count: 0 };
    const stateB = { count: 1 };
    const fiber = {
      tag: 0,
      memoizedState: makeHooksList([{ memoizedState: stateB, queue: {} }]),
      alternate: { memoizedState: makeHooksList([{ memoizedState: stateA, queue: {} }]) },
    };
    expect(detectStateChange(fiber)).toBe(true);
  });

  it('returns false when function component state is same reference', () => {
    const state = { count: 0 };
    const fiber = {
      tag: 0,
      memoizedState: makeHooksList([{ memoizedState: state, queue: {} }]),
      alternate: { memoizedState: makeHooksList([{ memoizedState: state, queue: {} }]) },
    };
    expect(detectStateChange(fiber)).toBe(false);
  });

  it('skips non-state hooks (useRef, useMemo — queue is null)', () => {
    const refA = { current: 'a' };
    const refB = { current: 'b' };
    const state = 42;
    const fiber = {
      tag: 0,
      memoizedState: makeHooksList([
        { memoizedState: refB, queue: null },    // useRef — different but should be skipped
        { memoizedState: state, queue: {} },      // useState — same
      ]),
      alternate: {
        memoizedState: makeHooksList([
          { memoizedState: refA, queue: null },
          { memoizedState: state, queue: {} },
        ]),
      },
    };
    expect(detectStateChange(fiber)).toBe(false);
  });

  it('detects class component state change (tag 1)', () => {
    const stateA = { value: 1 };
    const stateB = { value: 2 };
    const fiber = {
      tag: 1,
      memoizedState: stateB,
      alternate: { memoizedState: stateA },
    };
    expect(detectStateChange(fiber)).toBe(true);
  });

  it('returns false when class component state is same reference', () => {
    const state = { value: 1 };
    const fiber = {
      tag: 1,
      memoizedState: state,
      alternate: { memoizedState: state },
    };
    expect(detectStateChange(fiber)).toBe(false);
  });

  it('caps at MAX_HOOKS to prevent infinite loops', () => {
    // Create a circular linked list that would loop forever
    const hookA = { memoizedState: 1, queue: {}, next: null as any };
    hookA.next = hookA; // circular
    const hookB = { memoizedState: 1, queue: {}, next: null as any };
    hookB.next = hookB; // circular

    const fiber = {
      tag: 0,
      memoizedState: hookA,
      alternate: { memoizedState: hookB },
    };
    // Should return false without hanging (states are same value)
    expect(detectStateChange(fiber)).toBe(false);
  });

  it('returns false on error (graceful degradation)', () => {
    const fiber = {
      tag: 0,
      get memoizedState(): any { throw new Error('boom'); },
      alternate: { memoizedState: null },
    };
    expect(detectStateChange(fiber)).toBe(false);
  });
});

describe('isCompilerOptimized', () => {
  it('returns false for a plain function component', () => {
    const fiber = { tag: 0, updateQueue: null, memoizedState: null } as any;
    expect(isCompilerOptimized(fiber)).toBe(false);
  });

  it('detects compiler via updateQueue.memoCache', () => {
    const fiber = {
      tag: 0,
      updateQueue: { memoCache: { data: [1, 2, 3] } },
      memoizedState: null,
    } as any;
    expect(isCompilerOptimized(fiber)).toBe(true);
  });

  it('detects compiler via sentinel symbol in memoizedState', () => {
    const sentinel = Symbol.for('react.memo_cache_sentinel');
    const fiber = {
      tag: 0,
      updateQueue: null,
      memoizedState: { memoizedState: sentinel, queue: null, next: null },
    } as any;
    expect(isCompilerOptimized(fiber)).toBe(true);
  });

  it('detects compiler via sentinel in array inside memoizedState', () => {
    const sentinel = Symbol.for('react.memo_cache_sentinel');
    const fiber = {
      tag: 0,
      updateQueue: null,
      memoizedState: { memoizedState: [sentinel, 'other'], queue: null, next: null },
    } as any;
    expect(isCompilerOptimized(fiber)).toBe(true);
  });

  it('returns false when hooks exist but no compiler artifacts', () => {
    const fiber = {
      tag: 0,
      updateQueue: { lastEffect: null },
      memoizedState: {
        memoizedState: 42,
        queue: {},
        next: null,
      },
    } as any;
    expect(isCompilerOptimized(fiber)).toBe(false);
  });

  it('handles circular memoizedState without hanging (caps at 50)', () => {
    const hook = { memoizedState: 'normal', queue: {}, next: null as any };
    hook.next = hook; // circular
    const fiber = { tag: 0, updateQueue: null, memoizedState: hook } as any;
    expect(isCompilerOptimized(fiber)).toBe(false);
  });
});

describe('extractSourceLocation', () => {
  it('returns undefined when neither _debugSource nor _debugStack exists', () => {
    const fiber = { tag: 0 } as any;
    expect(extractSourceLocation(fiber)).toBeUndefined();
  });

  it('extracts from _debugSource (React 18)', () => {
    const fiber = {
      tag: 0,
      _debugSource: { fileName: 'src/components/UserList.tsx', lineNumber: 15, columnNumber: 3 },
    } as any;
    const result = extractSourceLocation(fiber);
    expect(result).toEqual({ fileName: 'src/components/UserList.tsx', lineNumber: 15 });
  });

  it('extracts from _debugStack string (React 19) with localhost URL', () => {
    const fiber = {
      tag: 0,
      _debugStack: '    at UserList (http://localhost:5173/src/components/UserList.tsx:15:3)\n    at div',
    } as any;
    const result = extractSourceLocation(fiber);
    expect(result).toEqual({ fileName: 'src/components/UserList.tsx', lineNumber: 15 });
  });

  it('extracts from _debugStack Error object (React 19)', () => {
    const err = new Error();
    err.stack = '    at Counter (http://localhost:5173/src/Counter.tsx:8:3)\n    at App';
    const fiber = { tag: 0, _debugStack: err } as any;
    const result = extractSourceLocation(fiber);
    expect(result).toEqual({ fileName: 'src/Counter.tsx', lineNumber: 8 });
  });

  it('extracts from _debugStack with https URL', () => {
    const fiber = {
      tag: 0,
      _debugStack: '    at App (https://example.com/src/App.tsx:42:5)',
    } as any;
    const result = extractSourceLocation(fiber);
    expect(result).toEqual({ fileName: 'src/App.tsx', lineNumber: 42 });
  });

  it('prefers _debugSource over _debugStack', () => {
    const fiber = {
      tag: 0,
      _debugSource: { fileName: 'from-source.tsx', lineNumber: 10 },
      _debugStack: '    at Comp (http://localhost:5173/from-stack.tsx:20:3)',
    } as any;
    const result = extractSourceLocation(fiber);
    expect(result).toEqual({ fileName: 'from-source.tsx', lineNumber: 10 });
  });

  it('returns undefined for unparseable _debugStack', () => {
    const fiber = {
      tag: 0,
      _debugStack: 'some random string with no matching pattern',
    } as any;
    expect(extractSourceLocation(fiber)).toBeUndefined();
  });
});

describe('parseSourceFromStack', () => {
  it('parses Chrome stack format', () => {
    const stack = '    at Counter (http://localhost:5173/src/Counter.tsx:8:3)\n    at App';
    expect(parseSourceFromStack(stack)).toEqual({ fileName: 'src/Counter.tsx', lineNumber: 8 });
  });

  it('parses Firefox/Safari stack format', () => {
    const stack = 'Counter@http://localhost:5173/src/Counter.tsx:8:3\nApp@http://localhost:5173/src/App.tsx:20:5';
    expect(parseSourceFromStack(stack)).toEqual({ fileName: 'src/Counter.tsx', lineNumber: 8 });
  });

  it('parses webpack URL format', () => {
    const stack = '    at UserList (webpack:///src/components/UserList.tsx:15:3)';
    expect(parseSourceFromStack(stack)).toEqual({ fileName: 'src/components/UserList.tsx', lineNumber: 15 });
  });

  it('returns undefined for empty string', () => {
    expect(parseSourceFromStack('')).toBeUndefined();
  });

  it('skips node_modules frames and returns first app source frame', () => {
    const stack = [
      '    at jsxDEV (http://localhost:5173/node_modules/.vite/deps/react_jsx-dev-runtime.js:244:12)',
      '    at Counter (http://localhost:5173/src/App.tsx:10:5)',
      '    at App (http://localhost:5173/src/App.tsx:42:3)',
    ].join('\n');
    expect(parseSourceFromStack(stack)).toEqual({ fileName: 'src/App.tsx', lineNumber: 10 });
  });

  it('falls back to node_modules frame when no app frame exists', () => {
    const stack = '    at Comp (http://localhost:5173/node_modules/some-lib/index.js:5:3)';
    expect(parseSourceFromStack(stack)).toEqual({ fileName: 'node_modules/some-lib/index.js', lineNumber: 5 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// walkFiberTree integration tests
// ─────────────────────────────────────────────────────────────────────────────

// Helper: Build a synthetic fiber tree rooted under a Profiler.
// Returns a DOM element with the __reactFiber$ key pointing into the tree.
function makeFiber(overrides: Partial<FiberNode> & { tag: number }): FiberNode {
  return {
    type: overrides.type ?? null,
    child: null,
    sibling: null,
    return: null,
    alternate: null,
    memoizedProps: overrides.memoizedProps ?? {},
    memoizedState: null,
    actualDuration: overrides.actualDuration ?? 1,
    stateNode: null,
    updateQueue: null,
    ...overrides,
  } as FiberNode;
}

// HostRoot tag in React internals (tag 3)
const HOST_ROOT_TAG = 3;

function makeFiberTree(
  children: FiberNode[],
  profilerOverrides?: Partial<FiberNode>,
): Element {
  // HostRoot sits above the Profiler, mimicking the real React tree.
  // stateNode.current = hostRoot marks this as the current (committed) tree.
  const hostRoot = makeFiber({ tag: HOST_ROOT_TAG, type: null, actualDuration: 0 });
  (hostRoot as any).stateNode = { current: hostRoot };

  const profiler = makeFiber({
    tag: PROFILER_TAG,
    type: null,
    actualDuration: 10,
    ...profilerOverrides,
  });
  profiler.return = hostRoot;
  hostRoot.child = profiler;

  // Link children as child → sibling chain under profiler
  for (let i = 0; i < children.length; i++) {
    children[i].return = profiler;
    if (i === 0) profiler.child = children[i];
    else children[i - 1].sibling = children[i];
  }

  // Create a DOM element with __reactFiber$ key pointing to a fiber
  // that has the profiler as an ancestor (walkFiberTree walks up via .return)
  const marker = document.createElement('span');
  const leafFiber = makeFiber({
    tag: 5, // HostComponent (div/span)
    type: 'span',
    return: profiler,
    actualDuration: 0,
  });
  (marker as any)['__reactFiber$test123'] = leafFiber;

  return marker;
}

function makeComponentFiber(
  name: string,
  overrides?: Partial<FiberNode>,
): FiberNode {
  return makeFiber({
    tag: FUNCTION_COMPONENT,
    type: { name },
    actualDuration: 1,
    memoizedProps: {},
    ...overrides,
  });
}

describe('walkFiberTree integration', () => {
  // --- Mount scenarios ---

  it('mount: single component', () => {
    const comp = makeComponentFiber('MyComponent', { actualDuration: 2 });
    const marker = makeFiberTree([comp]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    expect(result!.components).toHaveLength(1);
    expect(result!.components[0]).toMatchObject({
      name: 'MyComponent',
      phase: 'mount',
      renderCause: 'mount',
      unnecessary: false,
      depth: 0,
    });
  });

  it('mount: nested components have incrementing depth', () => {
    const child = makeComponentFiber('Child', { actualDuration: 0.5 });
    const parent = makeComponentFiber('Parent', { actualDuration: 2 });
    parent.child = child;
    child.return = parent;

    const marker = makeFiberTree([parent]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).toContain('Parent');
    expect(names).toContain('Child');

    const parentEntry = result!.components.find((c) => c.name === 'Parent')!;
    const childEntry = result!.components.find((c) => c.name === 'Child')!;
    expect(parentEntry.depth).toBe(0);
    expect(childEntry.depth).toBe(1);
  });

  it('mount: siblings share same depth', () => {
    const a = makeComponentFiber('SiblingA', { actualDuration: 1 });
    const b = makeComponentFiber('SiblingB', { actualDuration: 1 });
    a.sibling = b;

    const marker = makeFiberTree([a]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const aEntry = result!.components.find((c) => c.name === 'SiblingA')!;
    const bEntry = result!.components.find((c) => c.name === 'SiblingB')!;
    expect(aEntry.depth).toBe(bEntry.depth);
  });

  // --- Update scenarios ---

  it('update: state change detected', () => {
    const stateA = { count: 0 };
    const stateB = { count: 1 };
    const alternate = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Counter' },
      memoizedProps: { label: 'x' },
      memoizedState: { memoizedState: stateA, queue: {}, next: null },
      actualDuration: 1,
    });
    const comp = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Counter' },
      alternate,
      memoizedProps: { label: 'x' },
      memoizedState: { memoizedState: stateB, queue: {}, next: null },
      actualDuration: 2,
    });

    const marker = makeFiberTree([comp]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const entry = result!.components.find((c) => c.name === 'Counter')!;
    expect(entry.renderCause).toBe('state');
    expect(entry.phase).toBe('update');
    expect(result!.rootCauseComponents).toContain('Counter');
  });

  it('update: props change detected', () => {
    const alternate = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Display' },
      memoizedProps: { value: 'old' },
      memoizedState: null,
      actualDuration: 1,
    });
    const comp = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Display' },
      alternate,
      memoizedProps: { value: 'new' },
      memoizedState: null,
      actualDuration: 1.5,
    });

    const marker = makeFiberTree([comp]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const entry = result!.components.find((c) => c.name === 'Display')!;
    expect(entry.renderCause).toBe('props');
    expect(entry.changedProps).toContain('value');
  });

  it('update: props-and-state', () => {
    const stateA = { x: 1 };
    const stateB = { x: 2 };
    const alternate = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Both' },
      memoizedProps: { color: 'red' },
      memoizedState: { memoizedState: stateA, queue: {}, next: null },
      actualDuration: 1,
    });
    const comp = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Both' },
      alternate,
      memoizedProps: { color: 'blue' },
      memoizedState: { memoizedState: stateB, queue: {}, next: null },
      actualDuration: 2,
    });

    const marker = makeFiberTree([comp]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const entry = result!.components.find((c) => c.name === 'Both')!;
    expect(entry.renderCause).toBe('props-and-state');
    expect(result!.rootCauseComponents).toContain('Both');
  });

  it('update: parent forced (same props, same state)', () => {
    const props = { label: 'same' };
    const state = { count: 0 };
    const alternate = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Forced' },
      memoizedProps: props,
      memoizedState: { memoizedState: state, queue: {}, next: null },
      actualDuration: 1,
    });
    const comp = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Forced' },
      alternate,
      memoizedProps: props,
      memoizedState: { memoizedState: state, queue: {}, next: null },
      actualDuration: 0.5,
    });

    const marker = makeFiberTree([comp]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const entry = result!.components.find((c) => c.name === 'Forced')!;
    expect(entry.renderCause).toBe('parent');
    expect(entry.unnecessary).toBe(true);
  });

  // --- Bailout pruning ---

  it('LEVEL 1: prunes bailed-out component subtree (actualDuration=0 with alternate)', () => {
    // Bailed-out COMPONENT parent with a child that should be pruned
    const staleChild = makeComponentFiber('StaleChild', { actualDuration: 1 });
    const bailedParent = makeComponentFiber('BailedParent', {
      actualDuration: 0,
      alternate: makeFiber({
        tag: FUNCTION_COMPONENT,
        type: { name: 'BailedParent' },
        actualDuration: 0,
        memoizedProps: {},
        memoizedState: null,
      }),
    });
    bailedParent.child = staleChild;
    staleChild.return = bailedParent;

    // Active sibling that should still appear
    const activeComp = makeComponentFiber('ActiveSibling', { actualDuration: 1 });
    bailedParent.sibling = activeComp;

    const marker = makeFiberTree([bailedParent]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).not.toContain('StaleChild');
    expect(names).not.toContain('BailedParent');
    expect(names).toContain('ActiveSibling');
  });

  it('LEVEL 1: does NOT prune host fibers — traverses children even when actualDuration=0', () => {
    // Host fiber (div) with actualDuration=0 and no PerformedWork flag.
    // React never sets PerformedWork on host fibers, and bubbleProperties
    // on the bailout path doesn't accumulate children's actualDuration.
    // The walker must still traverse the host fiber's children.
    const renderedChild = makeComponentFiber('RenderedChild', { actualDuration: 2 });
    const hostDiv = makeFiber({
      tag: 5, // HostComponent
      type: 'div',
      alternate: makeFiber({ tag: 5, type: 'div', actualDuration: 0 }),
      actualDuration: 0,
    });
    hostDiv.child = renderedChild;
    renderedChild.return = hostDiv;

    const marker = makeFiberTree([hostDiv]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).toContain('RenderedChild');
  });

  it('LEVEL 2: excludes bailed-out parent with rendered children', () => {
    // Parent has actualDuration > 0 (bubbled from child) but selfDuration = 0
    const child = makeComponentFiber('InnerChild', { actualDuration: 3 });
    const parent = makeComponentFiber('OuterParent', { actualDuration: 3 });
    parent.alternate = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'OuterParent' },
      memoizedProps: parent.memoizedProps,
      memoizedState: parent.memoizedState,
      actualDuration: 3,
    });
    parent.child = child;
    child.return = parent;

    const marker = makeFiberTree([parent]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    // Parent has selfDuration=0 (all time from child), so it's excluded
    expect(names).not.toContain('OuterParent');
    // Child should still be included
    expect(names).toContain('InnerChild');
  });

  // --- Memo detection ---

  it('isMemoized set for SimpleMemoComponent (tag 14)', () => {
    const comp = makeFiber({
      tag: SIMPLE_MEMO_COMPONENT,
      type: { name: 'MemoComp' },
      actualDuration: 1,
      memoizedProps: {},
    });

    const marker = makeFiberTree([comp]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const entry = result!.components.find((c) => c.name === 'MemoComp')!;
    expect(entry.isMemoized).toBe(true);
  });

  it('isMemoized set for MemoComponent (tag 15)', () => {
    const comp = makeFiber({
      tag: MEMO_COMPONENT,
      type: { type: { name: 'MemoWrapped' } },
      actualDuration: 1,
      memoizedProps: {},
    });

    const marker = makeFiberTree([comp]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const entry = result!.components.find((c) => c.name === 'MemoWrapped')!;
    expect(entry.isMemoized).toBe(true);
  });

  // --- ForwardRef ---

  it('ForwardRef component (tag 11) included with correct name', () => {
    const comp = makeFiber({
      tag: FORWARD_REF,
      type: { render: { name: 'MyForwardRef' } },
      actualDuration: 1.5,
      memoizedProps: {},
    });

    const marker = makeFiberTree([comp]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    expect(result!.components).toHaveLength(1);
    expect(result!.components[0]).toMatchObject({
      name: 'MyForwardRef',
      phase: 'mount',
      renderCause: 'mount',
      unnecessary: false,
    });
  });

  // --- Depth tracking ---

  it('host elements do not increment depth', () => {
    // Component → div (tag 5) → Component
    const innerComp = makeComponentFiber('Inner', { actualDuration: 0.5 });
    const hostDiv = makeFiber({
      tag: 5,
      type: 'div',
      actualDuration: 1,
    });
    hostDiv.child = innerComp;
    innerComp.return = hostDiv;

    const outerComp = makeComponentFiber('Outer', { actualDuration: 2 });
    outerComp.child = hostDiv;
    hostDiv.return = outerComp;

    const marker = makeFiberTree([outerComp]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const outer = result!.components.find((c) => c.name === 'Outer')!;
    const inner = result!.components.find((c) => c.name === 'Inner')!;
    // Host div is transparent — inner should be depth 1, not depth 2
    expect(outer.depth).toBe(0);
    expect(inner.depth).toBe(1);
  });

  // --- Safety ---

  it('MAX_FIBERS cap limits traversal', () => {
    // Create a wide tree with > MAX_FIBERS siblings
    const fibers: FiberNode[] = [];
    for (let i = 0; i < MAX_FIBERS + 100; i++) {
      fibers.push(makeComponentFiber(`Comp${i}`, { actualDuration: 0.01 }));
    }
    // Link as siblings
    for (let i = 0; i < fibers.length - 1; i++) {
      fibers[i].sibling = fibers[i + 1];
    }

    const marker = makeFiberTree([fibers[0]]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    expect(result!.components.length).toBeLessThanOrEqual(MAX_FIBERS);
  });

  it('returns null on corrupted fiber (getter throws)', () => {
    const marker = document.createElement('span');
    const badFiber = {} as any;
    Object.defineProperty(badFiber, 'tag', {
      get() { throw new Error('corrupted'); },
    });
    // Build a minimal path: marker → fiber → profiler
    const profiler = makeFiber({ tag: PROFILER_TAG, actualDuration: 1 });
    badFiber.return = profiler;
    profiler.child = badFiber;
    // Give the profiler a child path that leads to the bad fiber
    const leafFiber = makeFiber({ tag: 5, type: 'span', return: profiler, actualDuration: 0 });
    (marker as any)['__reactFiber$test456'] = leafFiber;

    // The try/catch in walkFiberTree should catch and return null
    const result = walkFiberTree(marker);
    // walkFiberTree catches errors, so it should return null or a result without the bad fiber
    // The error occurs when accessing fiber.tag in the iteration
    expect(result === null || result.components.length === 0).toBe(true);
  });

  // --- Root cause detection ---

  it('rootCauseComponents populated for state-change components', () => {
    const stateA = { v: 1 };
    const stateB = { v: 2 };
    const alt1 = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'CompA' },
      memoizedProps: {},
      memoizedState: { memoizedState: stateA, queue: {}, next: null },
      actualDuration: 1,
    });
    const comp1 = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'CompA' },
      alternate: alt1,
      memoizedProps: {},
      memoizedState: { memoizedState: stateB, queue: {}, next: null },
      actualDuration: 1,
    });

    const stateC = { v: 3 };
    const stateD = { v: 4 };
    const alt2 = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'CompB' },
      memoizedProps: {},
      memoizedState: { memoizedState: stateC, queue: {}, next: null },
      actualDuration: 1,
    });
    const comp2 = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'CompB' },
      alternate: alt2,
      memoizedProps: {},
      memoizedState: { memoizedState: stateD, queue: {}, next: null },
      actualDuration: 1,
    });
    comp1.sibling = comp2;

    const marker = makeFiberTree([comp1]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    expect(result!.rootCauseComponents).toContain('CompA');
    expect(result!.rootCauseComponents).toContain('CompB');
  });

  // --- Stale fiber detection ---

  it('stale children skipped when host fiber bails out (alternate.child === fiber.child)', () => {
    // Host fiber bails out: alternate.child and fiber.child point to the same
    // component fiber. The walker should detect this as stale and skip the subtree.
    const staleChild = makeComponentFiber('StaleChild', { actualDuration: 50.4 });

    const oldCurrentHostDiv = makeFiber({ tag: 5, type: 'div', actualDuration: 0 });
    oldCurrentHostDiv.child = staleChild; // alternate has same .child pointer

    const hostDiv = makeFiber({
      tag: 5,
      type: 'div',
      alternate: oldCurrentHostDiv,
      actualDuration: 0,
    });
    hostDiv.child = staleChild; // same pointer as alternate.child → bailout

    const marker = makeFiberTree([hostDiv]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).not.toContain('StaleChild');
  });

  it('stale detection immune to double-buffering (alternate recycled as current)', () => {
    // Simulates commit 3: sectionA was recycled as the current fiber.
    // staleChild.return = sectionA — which would fool the .return pointer check.
    // But alternate.child === fiber.child correctly catches the bailout.
    const sectionB = makeFiber({ tag: 5, type: 'section', actualDuration: 0 });
    const staleChild = makeComponentFiber('StaleFromMount', { actualDuration: 50.4 });

    const sectionA = makeFiber({
      tag: 5,
      type: 'section',
      alternate: sectionB,
      actualDuration: 0,
    });

    // Both buffers share the same .child pointer (bailout, no cloneChildFibers)
    sectionA.child = staleChild;
    sectionB.child = staleChild;

    // staleChild.return points to sectionA — same object as WIP parent due to
    // double-buffer recycling. The .return check would say "not stale" here.
    staleChild.return = sectionA;

    const marker = makeFiberTree([sectionA]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).not.toContain('StaleFromMount');
  });

  it('cloned children included when cloneChildFibers ran (alternate.child !== fiber.child)', () => {
    // Host fiber rendered: cloneChildFibers created new child fibers,
    // so alternate.child !== fiber.child. Children should be included.
    const clonedChild = makeComponentFiber('ClonedChild', {
      actualDuration: 1,
      alternate: makeFiber({
        tag: FUNCTION_COMPONENT,
        type: { name: 'ClonedChild' },
        memoizedProps: { v: 1 },
        actualDuration: 1,
      }),
      flags: PERFORMED_WORK,
      memoizedProps: { v: 2 },
    });

    const oldChild = makeComponentFiber('OldChild', { actualDuration: 1 });
    const oldHostDiv = makeFiber({ tag: 5, type: 'div', actualDuration: 0 });
    oldHostDiv.child = oldChild; // alternate points to different child

    const hostDiv = makeFiber({
      tag: 5,
      type: 'div',
      alternate: oldHostDiv,
      actualDuration: 0,
    });
    hostDiv.child = clonedChild; // different from alternate.child → not stale
    clonedChild.return = hostDiv;

    const marker = makeFiberTree([hostDiv]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).toContain('ClonedChild');
  });

  it('stale subtree propagation: all descendants of stale fiber are skipped', () => {
    // Stale parent → stale child → stale grandchild. All should be skipped.
    const grandchild = makeComponentFiber('Grandchild', { actualDuration: 1 });
    const child = makeComponentFiber('Child', { actualDuration: 2 });
    child.child = grandchild;
    grandchild.return = child;

    const oldHostDiv = makeFiber({ tag: 5, type: 'div', actualDuration: 0 });
    oldHostDiv.child = child; // same pointer → bailout

    const hostDiv = makeFiber({
      tag: 5,
      type: 'div',
      alternate: oldHostDiv,
      actualDuration: 0,
    });
    hostDiv.child = child; // same as alternate.child → stale

    const marker = makeFiberTree([hostDiv]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).not.toContain('Child');
    expect(names).not.toContain('Grandchild');
  });

  it('stale sibling propagation: siblings of stale child are also skipped', () => {
    // When a parent bails out, ALL children (first child + siblings) are stale.
    const firstChild = makeComponentFiber('FirstChild', { actualDuration: 1 });
    const siblingChild = makeComponentFiber('SiblingChild', { actualDuration: 1 });
    firstChild.sibling = siblingChild;

    const oldHostDiv = makeFiber({ tag: 5, type: 'div', actualDuration: 0 });
    oldHostDiv.child = firstChild; // same pointer → bailout

    const hostDiv = makeFiber({
      tag: 5,
      type: 'div',
      alternate: oldHostDiv,
      actualDuration: 0,
    });
    hostDiv.child = firstChild; // same as alternate.child → stale

    // Active sibling of the host div should still appear
    const activeSibling = makeComponentFiber('ActiveSibling', { actualDuration: 1 });
    hostDiv.sibling = activeSibling;

    const marker = makeFiberTree([hostDiv]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).not.toContain('FirstChild');
    expect(names).not.toContain('SiblingChild');
    expect(names).toContain('ActiveSibling');
  });

  it('mount commit unaffected: host fiber without alternate does not trigger stale detection', () => {
    // During mount, host fibers have no alternate. alternate.child check
    // requires alternate != null, so children are never marked stale.
    const child = makeComponentFiber('MountChild', { actualDuration: 1 });
    const hostDiv = makeFiber({
      tag: 5,
      type: 'div',
      actualDuration: 0,
      // No alternate — this is a mount
    });
    hostDiv.child = child;
    child.return = hostDiv;

    const marker = makeFiberTree([hostDiv]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).toContain('MountChild');
  });

  // --- Host fiber traversal ---

  it('genuine new mount included during update commit (stale=false from rendered parent)', () => {
    // A component that rendered (has alternate + PerformedWork) with a new
    // child component (no alternate). Since the parent rendered, the child
    // is a genuine new mount — not stale.
    const newChild = makeComponentFiber('NewChild', { actualDuration: 0.5 });
    // newChild has no alternate (genuine new mount)

    const renderedParent = makeComponentFiber('RenderedParent', {
      actualDuration: 2,
      alternate: makeFiber({
        tag: FUNCTION_COMPONENT,
        type: { name: 'RenderedParent' },
        memoizedProps: { x: 1 },
        actualDuration: 1,
      }),
      flags: PERFORMED_WORK,
      memoizedProps: { x: 2 },
    });
    renderedParent.child = newChild;
    newChild.return = renderedParent;

    const marker = makeFiberTree([renderedParent]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).toContain('RenderedParent');
    expect(names).toContain('NewChild');
  });

  it('mount commit includes all fibers regardless of stale flag', () => {
    // During a 'mount' commit, no fibers should be filtered by stale detection.
    // Even fibers under a host-fiber boundary with mismatched .return pointers
    // are genuine mounts.
    const child = makeComponentFiber('MountChild', { actualDuration: 1 });

    const oldCurrentHostDiv = makeFiber({ tag: 5, type: 'div', actualDuration: 0 });
    const hostDiv = makeFiber({
      tag: 5, // HostComponent
      type: 'div',
      alternate: oldCurrentHostDiv,
      actualDuration: 0,
    });
    hostDiv.child = child;
    // child.return points to old parent — triggers stale detection
    child.return = oldCurrentHostDiv;

    const marker = makeFiberTree([hostDiv]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).toContain('MountChild');
  });

  it('WIP fiber with alternate is included when child.return === parent', () => {
    // A fiber whose .return points back to its parent was properly cloned
    // by cloneChildFibers — it's on the WIP tree and should be included.
    const childWithAlternate = makeComponentFiber('ClonedChild', {
      actualDuration: 1,
      alternate: makeFiber({
        tag: FUNCTION_COMPONENT,
        type: { name: 'ClonedChild' },
        memoizedProps: { v: 1 },
        actualDuration: 1,
      }),
      flags: PERFORMED_WORK,
      memoizedProps: { v: 2 },
    });

    const hostDiv = makeFiber({
      tag: 5, // HostComponent
      type: 'div',
      alternate: makeFiber({ tag: 5, type: 'div', actualDuration: 0 }),
      actualDuration: 0,
    });
    hostDiv.child = childWithAlternate;
    childWithAlternate.return = hostDiv;

    const marker = makeFiberTree([hostDiv]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    expect(names).toContain('ClonedChild');
  });

  // --- Alternate tree detection (double-buffering correctness) ---
  // React sets __reactFiber$ on DOM nodes only during mount — never during
  // updates. Due to double-buffering, on every other commit the DOM node
  // points to the alternate fiber tree. The walker must detect this and
  // switch to the current tree via FiberRoot.current.

  it('walks correct tree when marker fiber is on the current tree', () => {
    // Standard case: __reactFiber$ points to the current tree.
    // HostRoot.stateNode.current === hostRoot → we're on current tree.
    const comp = makeComponentFiber('CurrentComp', { actualDuration: 2 });
    const marker = makeFiberTree([comp]);
    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    expect(result!.components.map((c) => c.name)).toContain('CurrentComp');
  });

  it('switches to current profiler when marker fiber is on the alternate tree', () => {
    // Simulate: __reactFiber$ points to an alternate-tree fiber.
    // Build TWO trees: the "alternate" tree (wrong) and the "current" tree (correct).

    // Current tree: has the correct component
    const currentHostRoot = makeFiber({ tag: HOST_ROOT_TAG, type: null, actualDuration: 0 });
    const currentProfiler = makeFiber({ tag: PROFILER_TAG, type: null, actualDuration: 5 });
    currentProfiler.return = currentHostRoot;
    currentHostRoot.child = currentProfiler;
    const currentComp = makeComponentFiber('CorrectComp', { actualDuration: 2 });
    currentComp.return = currentProfiler;
    currentProfiler.child = currentComp;
    // FiberRoot.current points to the current HostRoot
    (currentHostRoot as any).stateNode = { current: currentHostRoot };

    // Alternate tree: has a different component (the one the marker points to)
    const altHostRoot = makeFiber({ tag: HOST_ROOT_TAG, type: null, actualDuration: 0 });
    const altProfiler = makeFiber({ tag: PROFILER_TAG, type: null, actualDuration: 0 });
    altProfiler.return = altHostRoot;
    altHostRoot.child = altProfiler;
    const altComp = makeComponentFiber('WrongComp', { actualDuration: 0 });
    altComp.return = altProfiler;
    altProfiler.child = altComp;
    // FiberRoot.current points to the CURRENT HostRoot (not this alternate one)
    (altHostRoot as any).stateNode = { current: currentHostRoot };

    // Cross-link alternates (double-buffering)
    currentHostRoot.alternate = altHostRoot;
    altHostRoot.alternate = currentHostRoot;
    currentProfiler.alternate = altProfiler;
    altProfiler.alternate = currentProfiler;

    // Marker DOM node's __reactFiber$ points to the ALTERNATE tree
    const marker = document.createElement('span');
    const altLeaf = makeFiber({
      tag: 5,
      type: 'span',
      return: altProfiler,
      actualDuration: 0,
    });
    (marker as any)['__reactFiber$test123'] = altLeaf;

    const result = walkFiberTree(marker);

    expect(result).not.toBeNull();
    const names = result!.components.map((c) => c.name);
    // Should walk the CURRENT tree (CorrectComp), not the alternate (WrongComp)
    expect(names).toContain('CorrectComp');
    expect(names).not.toContain('WrongComp');
  });

  it('gracefully handles profiler without HostRoot parent (e.g. tests)', () => {
    // When there's no HostRoot (profiler is the root), stateNode is null.
    // The alternate-tree check doesn't fire and the profiler is used as-is.
    const profiler = makeFiber({ tag: PROFILER_TAG, actualDuration: 1 });
    const comp = makeComponentFiber('TestComp', { actualDuration: 1 });
    comp.return = profiler;
    profiler.child = comp;

    const marker = document.createElement('span');
    const leaf = makeFiber({ tag: 5, type: 'span', return: profiler, actualDuration: 0 });
    (marker as any)['__reactFiber$test123'] = leaf;

    const result = walkFiberTree(marker);
    expect(result).not.toBeNull();
    expect(result!.components.map((c) => c.name)).toContain('TestComp');
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// getComponentName tests
// ─────────────────────────────────────────────────────────────────────────────

describe('getComponentName', () => {
  it('returns displayName when present', () => {
    const fiber = { type: { displayName: 'MyDisplay' } } as any;
    expect(getComponentName(fiber)).toBe('MyDisplay');
  });

  it('returns name when displayName absent', () => {
    const fiber = { type: { name: 'MyFunc' } } as any;
    expect(getComponentName(fiber)).toBe('MyFunc');
  });

  it('returns inner displayName for memo wrapper (type.type.displayName)', () => {
    const fiber = { type: { type: { displayName: 'MemoDisplay' } } } as any;
    expect(getComponentName(fiber)).toBe('MemoDisplay');
  });

  it('returns inner name for memo wrapper (type.type.name)', () => {
    const fiber = { type: { type: { name: 'MemoFunc' } } } as any;
    expect(getComponentName(fiber)).toBe('MemoFunc');
  });

  it('returns render displayName for forwardRef wrapper', () => {
    const fiber = { type: { render: { displayName: 'RefDisplay' } } } as any;
    expect(getComponentName(fiber)).toBe('RefDisplay');
  });

  it('returns render name for forwardRef wrapper (no displayName)', () => {
    const fiber = { type: { render: { name: 'RefFunc' } } } as any;
    expect(getComponentName(fiber)).toBe('RefFunc');
  });

  it('returns Unknown when type is falsy', () => {
    expect(getComponentName({ type: null } as any)).toBe('Unknown');
    expect(getComponentName({ type: undefined } as any)).toBe('Unknown');
  });

  it('returns Anonymous when no name anywhere', () => {
    const fiber = { type: {} } as any;
    expect(getComponentName(fiber)).toBe('Anonymous');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectChangedProps tests
// ─────────────────────────────────────────────────────────────────────────────

describe('detectChangedProps', () => {
  it('returns empty array on mount (no alternate)', () => {
    const fiber = { alternate: null, memoizedProps: { a: 1 } } as any;
    expect(detectChangedProps(fiber)).toEqual([]);
  });

  it('returns empty array when no props changed', () => {
    const val = { x: 1 };
    const fiber = {
      alternate: { memoizedProps: { obj: val } },
      memoizedProps: { obj: val },
    } as any;
    expect(detectChangedProps(fiber)).toEqual([]);
  });

  it('detects single prop change', () => {
    const fiber = {
      alternate: { memoizedProps: { color: 'red' } },
      memoizedProps: { color: 'blue' },
    } as any;
    expect(detectChangedProps(fiber)).toEqual(['color']);
  });

  it('detects multiple prop changes', () => {
    const fiber = {
      alternate: { memoizedProps: { a: 1, b: 2, c: 3 } },
      memoizedProps: { a: 10, b: 20, c: 3 },
    } as any;
    const changed = detectChangedProps(fiber);
    expect(changed).toContain('a');
    expect(changed).toContain('b');
    expect(changed).not.toContain('c');
  });

  it('skips children key even when changed', () => {
    const fiber = {
      alternate: { memoizedProps: { children: 'old', label: 'x' } },
      memoizedProps: { children: 'new', label: 'x' },
    } as any;
    const changed = detectChangedProps(fiber);
    expect(changed).not.toContain('children');
  });

  it('returns empty array when props are null', () => {
    const fiber = {
      alternate: { memoizedProps: null },
      memoizedProps: null,
    } as any;
    expect(detectChangedProps(fiber)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sumChildComponentDurations tests
// ─────────────────────────────────────────────────────────────────────────────

describe('sumChildComponentDurations', () => {
  it('returns 0 when no children', () => {
    const fiber = makeFiber({ tag: FUNCTION_COMPONENT, actualDuration: 5 });
    expect(sumChildComponentDurations(fiber, 0)).toBe(0);
  });

  it('sums component child actualDuration', () => {
    const child = makeComponentFiber('Child', { actualDuration: 3 });
    const parent = makeFiber({ tag: FUNCTION_COMPONENT, actualDuration: 5 });
    parent.child = child;
    expect(sumChildComponentDurations(parent, 0)).toBe(3);
  });

  it('recurses through host elements to find component grandchild', () => {
    const grandchild = makeComponentFiber('Grandchild', { actualDuration: 2 });
    const hostDiv = makeFiber({ tag: 5, type: 'div', actualDuration: 0 });
    hostDiv.child = grandchild;
    const parent = makeFiber({ tag: FUNCTION_COMPONENT, actualDuration: 5 });
    parent.child = hostDiv;
    expect(sumChildComponentDurations(parent, 0)).toBe(2);
  });

  it('returns 0 at MAX_DEPTH cap', () => {
    const child = makeComponentFiber('Deep', { actualDuration: 5 });
    const parent = makeFiber({ tag: FUNCTION_COMPONENT, actualDuration: 10 });
    parent.child = child;
    // Pass depth=100 (MAX_DEPTH) — should bail immediately
    expect(sumChildComponentDurations(parent, 100)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveFiberToDOM edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveFiberToDOM', () => {
  it('returns null when fiber has no host child (only component children)', () => {
    // A component fiber whose only children are other components — no HostComponent
    const innerComp = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Inner' },
      actualDuration: 1,
      memoizedProps: {},
    });
    const outerComp = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Outer' },
      actualDuration: 2,
      memoizedProps: {},
    });
    outerComp.child = innerComp;
    innerComp.return = outerComp;
    // innerComp has no children — traversal ends without finding a host element

    const result = resolveFiberToDOM(outerComp);
    expect(result).toBeNull();
  });

  it('returns null when fiber has no children at all', () => {
    const comp = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Leaf' },
      actualDuration: 1,
      memoizedProps: {},
    });

    const result = resolveFiberToDOM(comp);
    expect(result).toBeNull();
  });

  it('returns the first host child with an HTMLElement stateNode', () => {
    const hostDiv = makeFiber({
      tag: 5, // HostComponent
      type: 'div',
      actualDuration: 0,
    });
    const domNode = document.createElement('div');
    hostDiv.stateNode = domNode;

    const comp = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Wrapper' },
      actualDuration: 1,
      memoizedProps: {},
    });
    comp.child = hostDiv;
    hostDiv.return = comp;

    const result = resolveFiberToDOM(comp);
    expect(result).toBe(domNode);
  });

  it('returns null when deeply nested host fiber exceeds MAX_CHILD_HOPS', () => {
    // Build a chain of component fibers deeper than MAX_CHILD_HOPS,
    // with the host element beyond the hop limit.
    let current = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Root' },
      actualDuration: 1,
      memoizedProps: {},
    });
    const root = current;

    for (let i = 0; i < MAX_CHILD_HOPS; i++) {
      const next = makeFiber({
        tag: FUNCTION_COMPONENT,
        type: { name: `Deep${i}` },
        actualDuration: 0,
        memoizedProps: {},
      });
      current.child = next;
      next.return = current;
      current = next;
    }

    // Place the host element one step beyond MAX_CHILD_HOPS
    const hostDiv = makeFiber({
      tag: 5,
      type: 'div',
      actualDuration: 0,
    });
    hostDiv.stateNode = document.createElement('div');
    current.child = hostDiv;
    hostDiv.return = current;

    const result = resolveFiberToDOM(root);
    expect(result).toBeNull();
  });

  it('walks through component fibers to reach a host child', () => {
    // Component → Component → HostComponent (should find it within hop limit)
    const hostSpan = makeFiber({
      tag: 5,
      type: 'span',
      actualDuration: 0,
    });
    const domNode = document.createElement('span');
    hostSpan.stateNode = domNode;

    const middleComp = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Middle' },
      actualDuration: 0,
      memoizedProps: {},
    });
    middleComp.child = hostSpan;
    hostSpan.return = middleComp;

    const outerComp = makeFiber({
      tag: FUNCTION_COMPONENT,
      type: { name: 'Outer' },
      actualDuration: 1,
      memoizedProps: {},
    });
    outerComp.child = middleComp;
    middleComp.return = outerComp;

    const result = resolveFiberToDOM(outerComp);
    expect(result).toBe(domNode);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractSourceLocation edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('extractSourceLocation edge cases', () => {
  it('returns undefined when _debugStack is a number', () => {
    const fiber = { tag: 0, _debugStack: 42 } as any;
    expect(extractSourceLocation(fiber)).toBeUndefined();
  });

  it('returns undefined when _debugStack is an object without .stack property', () => {
    const fiber = { tag: 0, _debugStack: { message: 'no stack here' } } as any;
    expect(extractSourceLocation(fiber)).toBeUndefined();
  });

  it('returns undefined when _debugStack is a boolean', () => {
    const fiber = { tag: 0, _debugStack: true } as any;
    expect(extractSourceLocation(fiber)).toBeUndefined();
  });

  it('returns undefined when _debugStack is an empty string', () => {
    const fiber = { tag: 0, _debugStack: '' } as any;
    expect(extractSourceLocation(fiber)).toBeUndefined();
  });

  it('returns undefined when _debugStack Error has no matching frames in .stack', () => {
    const err = new Error();
    err.stack = 'Error: something\n    at Object.<anonymous> (internal:1:1)';
    const fiber = { tag: 0, _debugStack: err } as any;
    expect(extractSourceLocation(fiber)).toBeUndefined();
  });
});
