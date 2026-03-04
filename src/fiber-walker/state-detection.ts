import { CLASS_COMPONENT, MAX_HOOKS } from './types.js';

/**
 * Detect whether a fiber's state changed between this commit and the previous.
 *
 * Class components: compares `memoizedState` by reference (single object).
 * Function components: walks the hooks linked list and compares each
 * useState/useReducer hook's `memoizedState` by reference. Hooks with
 * `queue != null` are state hooks; others (useEffect, useMemo, etc.) are
 * skipped. Returns true if any state hook's value changed.
 */
export function detectStateChange(fiber: { tag: number; memoizedState: any; alternate: { memoizedState: any } | null }): boolean {
  try {
    if (!fiber.alternate) return false; // mount — no previous state

    // Class components: compare state object by reference
    if (fiber.tag === CLASS_COMPONENT) {
      return fiber.memoizedState !== fiber.alternate.memoizedState;
    }

    // Function components: walk hooks linked list
    // Each hook node has { memoizedState, next, queue }
    // Only hooks with queue != null are useState/useReducer
    let current = fiber.memoizedState;
    let prev = fiber.alternate.memoizedState;
    let count = 0;

    while (current && prev && count < MAX_HOOKS) {
      if (current.queue != null) {
        // This is a useState/useReducer hook — compare state by reference
        if (current.memoizedState !== prev.memoizedState) {
          return true;
        }
      }
      current = current.next;
      prev = prev.next;
      count++;
    }

    return false;
  } catch {
    return false;
  }
}
