// Named constants for React fiber tags
export const FUNCTION_COMPONENT = 0;
export const CLASS_COMPONENT = 1;
export const FORWARD_REF = 11;
export const SIMPLE_MEMO_COMPONENT = 14;
export const MEMO_COMPONENT = 15;

// Composite tag sets derived from named constants
export const COMPONENT_TAGS = new Set([
  FUNCTION_COMPONENT, CLASS_COMPONENT, FORWARD_REF,
  SIMPLE_MEMO_COMPONENT, MEMO_COMPONENT,
]);

// Tags 14 (SimpleMemoComponent) and 15 (MemoComponent) = React.memo()
export const MEMO_TAGS = new Set([SIMPLE_MEMO_COMPONENT, MEMO_COMPONENT]);

// Profiler tag in React internals
export const PROFILER_TAG = 12;

// React's PerformedWork fiber flag (bit 0 of fiber.flags).
// Set on fibers that completed render work. Unlike actualDuration (which
// depends on performance.now() precision and can round to 0 for fast
// components), this is a boolean — immune to timing precision issues.
export const PERFORMED_WORK = 1;

// Host element fiber tag (DOM nodes: div, span, etc.)
export const HOST_COMPONENT_TAG = 5;

// Safety caps to prevent hanging on enormous trees
export const MAX_FIBERS = 2000;
export const MAX_DEPTH = 100;
export const MAX_HOOKS = 50;
export const MAX_CHILD_HOPS = 50;

/**
 * Subset of React's internal Fiber type used by the walker. These fields are
 * stable across React 16–19 and are the same fields React DevTools depends on.
 *
 * React uses a double-buffered fiber architecture: two fiber objects (current
 * and workInProgress) alternate roles across commits. The `alternate` field
 * links them. After a commit, the WIP tree becomes current and vice versa.
 *
 * Key invariant for the walker: after a commit, `fiber.alternate.child ===
 * fiber.child` means cloneChildFibers was NOT called — the children are
 * inherited from the previous tree (stale). This is how we detect bailouts.
 */
export interface FiberNode {
  /** React fiber type tag — determines component kind (0=Function, 1=Class, 5=Host, 12=Profiler, etc.) */
  tag: number;
  /** Component function/class, or host element string ('div', 'span'). null for fragments. */
  type: any;
  /** First child fiber. Updated by reconcileChildren or cloneChildFibers. */
  child: FiberNode | null;
  /** Next sibling fiber. Forms a linked list of children under a common parent. */
  sibling: FiberNode | null;
  /** Parent fiber. Set during reconciliation — note: may be stale on alternate-tree fibers. */
  return: FiberNode | null;
  /** The other buffer in double-buffering. current.alternate = WIP, WIP.alternate = current. */
  alternate: FiberNode | null;
  /** Props after the last completed render. Compared with alternate.memoizedProps for prop diffing. */
  memoizedProps: Record<string, unknown> | null;
  /** Hooks linked list (function components) or state object (class components). */
  memoizedState: any;
  /** Total render time of this fiber and its subtree in ms. Reset to 0 by createWorkInProgress. Only tracked inside Profiler boundaries. */
  actualDuration?: number;
  /** Bitfield — PerformedWork (bit 0) indicates the fiber completed render work. */
  flags?: number;
  /** Incoming props for the current render pass. Same as memoizedProps after commit. */
  pendingProps?: Record<string, unknown> | null;
  /** DOM node (host fibers), component instance (class), or FiberRoot (HostRoot tag 3). */
  stateNode: any;
  /** Effect queue (function components) or class update queue. Structure differs by fiber type. */
  updateQueue: any;
  /** React 18 debug info — direct source location of the component. */
  _debugSource?: { fileName: string; lineNumber: number; columnNumber?: number };
  /** React 19 debug info — stack trace string or Error object captured at component creation. */
  _debugStack?: string | Error;
}
