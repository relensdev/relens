import type { UserEventEntry } from './types.js';

type UserEventCallback = (entry: UserEventEntry) => void;

let activeCallback: UserEventCallback | null = null;
const scrollTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
let installedListeners: Array<[string, (e: Event) => void]> = [];

/**
 * Number of active providers that have `userEvents={true}`. Uses a simple
 * numeric counter rather than a Set keyed by profileId, because the capture
 * is a global singleton and the provider registry owns the per-ID ref count.
 * A numeric counter correctly handles duplicate profileIds.
 */
let activeCount = 0;

const ALLOWED_KEYS = new Set([
  'Enter', 'Escape', 'Tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Backspace', 'Delete',
]);

const SCROLL_DEBOUNCE_MS = 150;
const TEXT_MAX_LENGTH = 80;

function buildSelector(el: Element): string {
  // data-testid is the strongest identifier (many apps have these for testing)
  const testId = el.getAttribute('data-testid');
  if (testId) {
    return `[data-testid="${testId}"]`;
  }

  // ID
  if (el.id) {
    return `${el.tagName.toLowerCase()}#${el.id}`;
  }

  // aria-label (accessible apps have these)
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) {
    return `${el.tagName.toLowerCase()}[aria-label="${ariaLabel}"]`;
  }

  // name attribute (form elements)
  const name = el.getAttribute('name');
  if (name) {
    return `${el.tagName.toLowerCase()}[name="${name}"]`;
  }

  let selector = el.tagName.toLowerCase();

  if (el.className && typeof el.className === 'string') {
    const classes = el.className.trim().split(/\s+/).slice(0, 3);
    if (classes.length > 0 && classes[0] !== '') {
      selector += '.' + classes.join('.');
    }
  }

  // If selector is just a tag name, add nth-child for specificity
  if (selector === el.tagName.toLowerCase() && el.parentElement) {
    const parent = el.parentElement;
    const siblings = Array.from(parent.children).filter(
      (c) => c.tagName === el.tagName
    );
    if (siblings.length > 1) {
      const index = siblings.indexOf(el) + 1;
      selector += `:nth-of-type(${index})`;
    }
  }

  return selector;
}

function getTextContent(el: Element): string | undefined {
  const text = el.textContent?.trim();
  if (!text) return undefined;
  return text.length > TEXT_MAX_LENGTH ? text.slice(0, TEXT_MAX_LENGTH) : text;
}

function isPasswordInput(el: Element): boolean {
  return (
    el instanceof HTMLInputElement && el.type === 'password'
  );
}

function buildBaseEntry(
  type: UserEventEntry['type'],
  target: Element
): UserEventEntry {
  const entry: UserEventEntry = {
    type,
    timestamp: Date.now(),
    target: {
      selector: buildSelector(target),
      tagName: target.tagName.toLowerCase(),
    },
  };

  // Capture enriched target metadata for resilient replay matching
  const testId = target.getAttribute('data-testid');
  if (testId) entry.target.testId = testId;

  const ariaLabel = target.getAttribute('aria-label');
  if (ariaLabel) entry.target.ariaLabel = ariaLabel;

  const name = target.getAttribute('name');
  if (name) entry.target.name = name;

  return entry;
}

function handleClick(e: Event): void {
  const target = e.target as Element | null;
  if (!target) return;

  const entry = buildBaseEntry('click', target);
  const text = getTextContent(target);
  if (text) entry.target.textContent = text;

  try { activeCallback?.(entry); } catch { /* never crash app */ }
}

function handleInput(e: Event): void {
  const target = e.target as Element | null;
  if (!target) return;
  if (isPasswordInput(target)) return;

  const entry = buildBaseEntry('input', target);

  if (target instanceof HTMLInputElement) {
    entry.target.inputType = target.type || 'text';
    entry.valueLength = target.value.length;
  } else if (target instanceof HTMLTextAreaElement) {
    entry.target.inputType = 'textarea';
    entry.valueLength = target.value.length;
  }

  try { activeCallback?.(entry); } catch { /* never crash app */ }
}

function handleKeydown(e: Event): void {
  const ke = e as KeyboardEvent;
  if (!ALLOWED_KEYS.has(ke.key)) return;

  const target = ke.target as Element | null;
  if (!target) return;
  if (isPasswordInput(target)) return;

  const entry = buildBaseEntry('keydown', target);
  entry.key = ke.key;

  try { activeCallback?.(entry); } catch { /* never crash app */ }
}

function handleScroll(e: Event): void {
  const rawTarget = e.target;
  if (!rawTarget) return;

  // Scroll target can be document or an element
  const isDoc = rawTarget === document || rawTarget === document.documentElement;
  const el: Element = isDoc ? document.documentElement : rawTarget as Element;
  const key = isDoc ? 'document' : buildSelector(el);

  // Debounce per target
  const existing = scrollTimers.get(key);
  if (existing) clearTimeout(existing);

  scrollTimers.set(
    key,
    setTimeout(() => {
      scrollTimers.delete(key);

      const entry = buildBaseEntry('scroll', el);

      // Capture scroll position for replay
      if (isDoc) {
        entry.scrollX = window.scrollX;
        entry.scrollY = window.scrollY;
      } else {
        entry.scrollX = (el as HTMLElement).scrollLeft;
        entry.scrollY = (el as HTMLElement).scrollTop;
      }

      try { activeCallback?.(entry); } catch { /* never crash app */ }
    }, SCROLL_DEBOUNCE_MS)
  );
}

function handleSubmit(e: Event): void {
  const target = e.target as Element | null;
  if (!target) return;

  const entry = buildBaseEntry('submit', target);
  const text = getTextContent(target);
  if (text) entry.target.textContent = text;

  try { activeCallback?.(entry); } catch { /* never crash app */ }
}

function handleFocus(e: Event): void {
  const target = e.target as Element | null;
  if (!target) return;

  const entry = buildBaseEntry('focus', target);
  if (target instanceof HTMLInputElement) {
    entry.target.inputType = target.type || 'text';
  }

  try { activeCallback?.(entry); } catch { /* never crash app */ }
}

function handleBlur(e: Event): void {
  const target = e.target as Element | null;
  if (!target) return;

  const entry = buildBaseEntry('blur', target);
  if (target instanceof HTMLInputElement) {
    entry.target.inputType = target.type || 'text';
  }

  try { activeCallback?.(entry); } catch { /* never crash app */ }
}

/**
 * Register a profileId as having `userEvents={true}` and install event
 * listeners if not already installed. The callback is shared across all
 * providers -- user events are page-level, not provider-scoped.
 *
 * @param profileId - The provider's profileId (its `id` prop)
 * @param callback - Called for each captured user event. Only the first
 *   caller's callback is used.
 */
export function installUserEventCapture(profileId: string, callback: UserEventCallback): void {
  activeCount++;

  if (activeCount > 1) return; // already listening

  activeCallback = callback;

  if (typeof document === 'undefined') return;

  const listeners: Array<[string, (e: Event) => void, boolean | AddEventListenerOptions]> = [
    ['click', handleClick, true],
    ['input', handleInput, true],
    ['keydown', handleKeydown, true],
    ['scroll', handleScroll, { capture: true, passive: true }],
    ['submit', handleSubmit, true],
    ['focus', handleFocus, true],
    ['blur', handleBlur, true],
  ];

  for (const [event, handler, options] of listeners) {
    document.addEventListener(event, handler, options);
    installedListeners.push([event, handler]);
  }
}

/**
 * Decrement the active provider count. When the count reaches zero, all
 * listeners are removed.
 *
 * @param profileId - The provider's profileId (kept for API compatibility).
 */
export function uninstallUserEventCapture(_profileId: string): void {
  activeCount = Math.max(0, activeCount - 1);

  if (activeCount > 0) return; // other providers still active

  activeCallback = null;

  // Clear pending scroll debounces
  for (const timer of scrollTimers.values()) {
    clearTimeout(timer);
  }
  scrollTimers.clear();

  // Remove all listeners
  if (typeof document !== 'undefined') {
    for (const [event, handler] of installedListeners) {
      document.removeEventListener(event, handler, true);
    }
  }
  installedListeners = [];
}
