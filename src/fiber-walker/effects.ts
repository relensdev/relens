import type { EffectInfo } from '../types.js';
import { CLASS_COMPONENT } from './types.js';

// Effect tag bits from React internals (react-reconciler/src/ReactHookEffectTags.js).
// These are bitwise flags on each effect node in the circular linked list.
const HAS_EFFECT = 1;  // Effect's deps changed — it will fire this commit
const LAYOUT = 4;      // useLayoutEffect (synchronous, blocks paint)
const PASSIVE = 8;     // useEffect (asynchronous, after paint)

// Safety cap for circular effect linked list traversal
const MAX_EFFECTS = 50;

/**
 * Extract effect metadata from a function component fiber.
 *
 * React stores effects in a circular linked list at `fiber.updateQueue.lastEffect`.
 * Each node has a `tag` bitfield (HAS_EFFECT | LAYOUT | PASSIVE), a `deps` array,
 * and a `destroy` function (cleanup). Class components have a different updateQueue
 * structure and are skipped.
 *
 * Returns null for class components or fibers with no effects.
 */
export function extractEffects(fiber: { tag: number; updateQueue: any }): EffectInfo[] | null {
  try {
    // Class components have a different updateQueue structure — skip them
    if (fiber.tag === CLASS_COMPONENT) return null;

    const queue = fiber.updateQueue;
    if (!queue || typeof queue !== 'object') return null;

    const lastEffect = queue.lastEffect;
    if (!lastEffect || typeof lastEffect !== 'object') return null;

    // React stores effects in a circular linked list: lastEffect.next → first → ... → lastEffect
    const effects: EffectInfo[] = [];
    let current = lastEffect.next;
    if (!current || typeof current !== 'object') return null;

    let count = 0;
    do {
      if (count >= MAX_EFFECTS) break;

      const tag = typeof current.tag === 'number' ? current.tag : 0;
      const isLayout = (tag & LAYOUT) !== 0;
      const isPassive = (tag & PASSIVE) !== 0;

      // Skip effects that are neither useEffect nor useLayoutEffect
      if (isLayout || isPassive) {
        const fired = (tag & HAS_EFFECT) !== 0;
        const deps = current.deps;
        const depsCount = Array.isArray(deps) ? deps.length : null;
        const hasCleanup = typeof current.destroy === 'function';

        effects.push({
          type: isLayout ? 'useLayoutEffect' : 'useEffect',
          fired,
          depsCount,
          hasCleanup,
          index: effects.length,
        });
      }

      count++;
      current = current.next;
    } while (current && current !== lastEffect.next);

    return effects.length > 0 ? effects : null;
  } catch {
    return null;
  }
}
