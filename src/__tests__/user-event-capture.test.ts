import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installUserEventCapture, uninstallUserEventCapture } from '../user-event-capture.js';
import type { UserEventEntry } from '../types.js';

beforeEach(() => {
  // Clean slate
  document.body.innerHTML = '';
});

afterEach(() => {
  // Force-reset ref count
  try { uninstallUserEventCapture('test'); } catch { /* ignore */ }
  try { uninstallUserEventCapture('test2'); } catch { /* ignore */ }
  document.body.innerHTML = '';
});

describe('User Event Capture', () => {
  it('captures click events with selector and tag', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const btn = document.createElement('button');
    btn.id = 'submit-btn';
    btn.textContent = 'Submit';
    document.body.appendChild(btn);

    btn.click();

    uninstallUserEventCapture('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('click');
    expect(entries[0].target.selector).toBe('button#submit-btn');
    expect(entries[0].target.tagName).toBe('button');
    expect(entries[0].target.textContent).toBe('Submit');
    expect(entries[0].timestamp).toBeTypeOf('number');
  });

  it('captures input events with valueLength but not value', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'name-input';
    document.body.appendChild(input);

    // Set value and dispatch input event
    input.value = 'hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    uninstallUserEventCapture('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('input');
    expect(entries[0].valueLength).toBe(5);
    expect(entries[0].target.inputType).toBe('text');
    // Value itself should NOT be captured
    expect((entries[0] as any).value).toBeUndefined();
  });

  it('skips password input elements entirely', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const input = document.createElement('input');
    input.type = 'password';
    document.body.appendChild(input);

    input.value = 'secret123';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    uninstallUserEventCapture('test');

    expect(entries).toHaveLength(0);
  });

  it('skips password fields for keydown events', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const input = document.createElement('input');
    input.type = 'password';
    document.body.appendChild(input);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    uninstallUserEventCapture('test');

    expect(entries).toHaveLength(0);
  });

  it('only captures allowed special keys for keydown', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const input = document.createElement('input');
    document.body.appendChild(input);

    // Allowed keys
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));

    // Non-allowed keys (regular typing)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));

    uninstallUserEventCapture('test');

    expect(entries).toHaveLength(5);
    expect(entries.map(e => e.key)).toEqual(['Enter', 'Escape', 'Tab', 'ArrowUp', 'Backspace']);
  });

  it('debounces scroll events per target', async () => {
    vi.useFakeTimers();
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const div = document.createElement('div');
    div.id = 'scroller';
    document.body.appendChild(div);

    // Fire multiple scroll events rapidly
    div.dispatchEvent(new Event('scroll', { bubbles: true }));
    div.dispatchEvent(new Event('scroll', { bubbles: true }));
    div.dispatchEvent(new Event('scroll', { bubbles: true }));

    // Before debounce fires
    expect(entries).toHaveLength(0);

    // After debounce period
    vi.advanceTimersByTime(200);

    uninstallUserEventCapture('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('scroll');

    vi.useRealTimers();
  });

  it('truncates textContent to 80 chars', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const btn = document.createElement('button');
    btn.textContent = 'A'.repeat(100);
    document.body.appendChild(btn);

    btn.click();

    uninstallUserEventCapture('test');

    expect(entries[0].target.textContent).toHaveLength(80);
  });

  it('captures submit events', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const form = document.createElement('form');
    form.id = 'login-form';
    document.body.appendChild(form);

    form.dispatchEvent(new Event('submit', { bubbles: true }));

    uninstallUserEventCapture('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('submit');
    expect(entries[0].target.selector).toBe('form#login-form');
  });

  it('captures focus and blur events', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const input = document.createElement('input');
    input.type = 'email';
    input.id = 'email';
    document.body.appendChild(input);

    input.dispatchEvent(new Event('focus', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));

    uninstallUserEventCapture('test');

    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe('focus');
    expect(entries[0].target.inputType).toBe('email');
    expect(entries[1].type).toBe('blur');
  });

  it('ref-counted install — calling twice only installs once', () => {
    const entries1: UserEventEntry[] = [];
    const entries2: UserEventEntry[] = [];

    installUserEventCapture('test', (entry) => entries1.push(entry));
    installUserEventCapture('test2', (entry) => entries2.push(entry));

    const btn = document.createElement('button');
    btn.textContent = 'Test';
    document.body.appendChild(btn);
    btn.click();

    // First callback should be active
    expect(entries1.length + entries2.length).toBe(1);
    expect(entries1).toHaveLength(1);

    uninstallUserEventCapture('test'); // decrement to 1
    uninstallUserEventCapture('test2'); // decrement to 0, remove listeners
  });

  it('uninstall removes all listeners', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));
    uninstallUserEventCapture('test');

    const btn = document.createElement('button');
    btn.textContent = 'Test';
    document.body.appendChild(btn);
    btn.click();

    expect(entries).toHaveLength(0);
  });

  it('builds selector with classes when no id', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    document.body.appendChild(btn);

    btn.click();

    uninstallUserEventCapture('test');

    expect(entries[0].target.selector).toBe('button.btn.btn-primary');
  });

  it('prioritizes data-testid in selector', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const btn = document.createElement('button');
    btn.setAttribute('data-testid', 'submit-btn');
    btn.id = 'btn1';
    btn.className = 'primary';
    document.body.appendChild(btn);

    btn.click();

    uninstallUserEventCapture('test');

    expect(entries[0].target.selector).toBe('[data-testid="submit-btn"]');
    expect(entries[0].target.testId).toBe('submit-btn');
  });

  it('uses aria-label in selector when no testid or id', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const btn = document.createElement('button');
    btn.setAttribute('aria-label', 'Close dialog');
    document.body.appendChild(btn);

    btn.click();

    uninstallUserEventCapture('test');

    expect(entries[0].target.selector).toBe('button[aria-label="Close dialog"]');
    expect(entries[0].target.ariaLabel).toBe('Close dialog');
  });

  it('uses name attribute in selector for form elements', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const input = document.createElement('input');
    input.setAttribute('name', 'email');
    input.type = 'email';
    document.body.appendChild(input);

    input.value = 'test@test.com';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    uninstallUserEventCapture('test');

    expect(entries[0].target.selector).toBe('input[name="email"]');
    expect(entries[0].target.name).toBe('email');
  });

  it('captures enriched target metadata on click events', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const btn = document.createElement('button');
    btn.setAttribute('data-testid', 'save-btn');
    btn.setAttribute('aria-label', 'Save changes');
    btn.setAttribute('name', 'save');
    btn.textContent = 'Save';
    document.body.appendChild(btn);

    btn.click();

    uninstallUserEventCapture('test');

    expect(entries[0].target.testId).toBe('save-btn');
    expect(entries[0].target.ariaLabel).toBe('Save changes');
    expect(entries[0].target.name).toBe('save');
    expect(entries[0].target.textContent).toBe('Save');
  });

  it('captures scroll position on scroll events', () => {
    vi.useFakeTimers();
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    // Scroll on document
    document.dispatchEvent(new Event('scroll', { bubbles: true }));

    vi.advanceTimersByTime(200);

    uninstallUserEventCapture('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('scroll');
    expect(entries[0].scrollX).toBeTypeOf('number');
    expect(entries[0].scrollY).toBeTypeOf('number');

    vi.useRealTimers();
  });

  it('clears pending scroll timers on uninstall', () => {
    vi.useFakeTimers();
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const div = document.createElement('div');
    document.body.appendChild(div);
    div.dispatchEvent(new Event('scroll', { bubbles: true }));

    // Uninstall before debounce fires
    uninstallUserEventCapture('test');

    vi.advanceTimersByTime(200);

    // Should NOT have captured the scroll
    expect(entries).toHaveLength(0);

    vi.useRealTimers();
  });

  it('captures textarea input with valueLength', () => {
    const entries: UserEventEntry[] = [];
    installUserEventCapture('test', (entry) => entries.push(entry));

    const textarea = document.createElement('textarea');
    textarea.id = 'comment';
    document.body.appendChild(textarea);

    textarea.value = 'Hello world';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    uninstallUserEventCapture('test');

    expect(entries).toHaveLength(1);
    expect(entries[0].target.inputType).toBe('textarea');
    expect(entries[0].valueLength).toBe(11);
  });
});
