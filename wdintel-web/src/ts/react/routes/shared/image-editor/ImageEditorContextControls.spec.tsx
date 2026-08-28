/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ImageEditorCompactNumericControl } from './ImageEditorContextControls';

describe('ImageEditorCompactNumericControl', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function render(onChange = vi.fn()) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <ImageEditorCompactNumericControl
          label="Розмір тексту"
          value={36}
          min={10}
          max={160}
          onChange={onChange}
          disabled={false}
        />,
      ),
    );
    return {
      input: container.querySelector('input[aria-label="Розмір тексту"]') as HTMLInputElement,
      onChange,
    };
  }

  async function changeDraft(input: HTMLInputElement, value: string) {
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('exposes the accessible name on the native input', async () => {
    const { input } = await render();
    expect(input).not.toBeNull();
  });

  it('commits a clamped draft once on Enter', async () => {
    const { input, onChange } = await render();
    await changeDraft(input, '200');
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(160);
  });

  it('restores the draft without committing or propagating Escape', async () => {
    const { input, onChange } = await render();
    const parentEscape = vi.fn();
    window.addEventListener('keydown', parentEscape);
    await changeDraft(input, '50');
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(input.value).toBe('36');
    expect(onChange).not.toHaveBeenCalled();
    expect(parentEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', parentEscape);
  });
});
