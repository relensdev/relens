import type { FiberNode } from './types.js';
import { COMPONENT_TAGS, MAX_DEPTH } from './types.js';

/**
 * Extract a human-readable component name from a fiber. Handles the
 * wrapping layers that React.memo() and React.forwardRef() add:
 *   - Direct: fiber.type.displayName || fiber.type.name
 *   - memo():  fiber.type.type.displayName || fiber.type.type.name
 *   - forwardRef(): fiber.type.render.displayName || fiber.type.render.name
 */
export function getComponentName(fiber: FiberNode): string {
  const type = fiber.type;
  if (!type) return 'Unknown';

  // Direct displayName or name
  if (type.displayName) return type.displayName;
  if (type.name) return type.name;

  // memo(Component) wraps as { type: Component, ... }
  if (type.type) {
    if (type.type.displayName) return type.type.displayName;
    if (type.type.name) return type.type.name;
  }

  // forwardRef(Component) wraps as { render: Component, ... }
  if (type.render) {
    if (type.render.displayName) return type.render.displayName;
    if (type.render.name) return type.render.name;
  }

  return 'Anonymous';
}

/**
 * Sum the actualDuration of all direct component children (not grandchildren).
 * Used to compute selfDuration = actualDuration - childComponentDurations.
 *
 * Recurses through host fibers (div, span) transparently to find component
 * children, but stops at the first component layer — the component's own
 * actualDuration already includes its subtree via React's bubbleProperties.
 */
export function sumChildComponentDurations(fiber: FiberNode, depth: number): number {
  if (depth >= MAX_DEPTH) return 0;

  let total = 0;
  let child = fiber.child;
  while (child) {
    if (COMPONENT_TAGS.has(child.tag) && (child.actualDuration ?? 0) > 0) {
      // Component child — count its full duration, don't recurse further
      total += child.actualDuration!;
    } else {
      // Host element or other non-component — recurse through it
      total += sumChildComponentDurations(child, depth + 1);
    }
    child = child.sibling;
  }
  return total;
}

/**
 * Compare current and previous props by reference to find which prop keys
 * changed. Skips 'children' (always changes by reference in JSX).
 * Returns an empty array on mount (no alternate) or when no props changed.
 */
export function detectChangedProps(fiber: FiberNode): string[] {
  const prev = fiber.alternate;
  if (!prev) return []; // mount — no previous props

  const currentProps = fiber.memoizedProps;
  const prevProps = prev.memoizedProps;

  if (!currentProps || !prevProps) return [];

  const changed: string[] = [];
  const allKeys = new Set([...Object.keys(currentProps), ...Object.keys(prevProps)]);

  for (const key of allKeys) {
    if (key === 'children') continue; // always changes by reference in JSX
    if (currentProps[key] !== prevProps[key]) {
      changed.push(key);
    }
  }

  return changed;
}
