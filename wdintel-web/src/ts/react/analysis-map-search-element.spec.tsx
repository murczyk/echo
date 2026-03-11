/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import './analysis-map-search-element';

const TAG = 'analysis-map-search';
const DEBOUNCE_MS = 300;

async function connectElement(el: HTMLElement, container: HTMLElement): Promise<void> {
  await act(async () => {
    container.appendChild(el);
  });
}

function createElement(): HTMLElement & {
  setResultsCount: (count: number | null) => void;
  setSearchLoading: (isLoading: boolean) => void;
} {
  const el = document.createElement(TAG);
  return el as HTMLElement & {
    setResultsCount: (count: number | null) => void;
    setSearchLoading: (isLoading: boolean) => void;
  };
}

function getInput(el: HTMLElement): HTMLInputElement {
  const input = el.querySelector('input');
  if (!input) throw new Error('Input not found');
  return input;
}

function getClearButton(el: HTMLElement): HTMLButtonElement | null {
  return el.querySelector('button[aria-label="Очистити"]');
}

function typeInput(input: HTMLInputElement, value: string): void {
  input.focus();
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  nativeInputValueSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('AnalysisMapSearchElement', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  describe('search input handling', () => {
    it('fires multiple events when symbols are entered with a gap greater than debounce', async () => {
      vi.useFakeTimers();
      const el = createElement();
      await connectElement(el, container);
      const events: string[] = [];
      el.addEventListener('search-points', (e: Event) => events.push((e as CustomEvent).detail));
      const input = getInput(el);

      typeInput(input, 'a');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
      expect(events).toEqual(['a']);

      typeInput(input, 'ab');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
      expect(events).toEqual(['a', 'ab']);

      typeInput(input, 'abc');
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
      expect(events).toEqual(['a', 'ab', 'abc']);

      vi.useRealTimers();
    });

    it('fires a single event when symbols are entered within debounce window', async () => {
      vi.useFakeTimers();
      const el = createElement();
      await connectElement(el, container);
      const events: string[] = [];
      el.addEventListener('search-points', (e: Event) => events.push((e as CustomEvent).detail));
      const input = getInput(el);

      typeInput(input, 'a');
      await vi.advanceTimersByTimeAsync(50);
      typeInput(input, 'ab');
      await vi.advanceTimersByTimeAsync(50);
      typeInput(input, 'abc');
      expect(events).toEqual([]);

      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS + 1);
      expect(events).toEqual(['abc']);

      vi.useRealTimers();
    });
  });
});
