/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoordinateListInput } from './CoordinateListInput';

describe('CoordinateListInput duplicate feedback', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps a pasted duplicate visible and shows a neutral status hint', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    const onErrorChange = vi.fn();

    await act(async () => {
      root.render(
        <CoordinateListInput
          value="49.123457, 37.234568"
          onChange={onChange}
          onBlur={vi.fn()}
          onErrorChange={onErrorChange}
          disabled={false}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>('input');
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: () => '49.12346, 37.23457' },
    });
    await act(async () => {
      input?.dispatchEvent(pasteEvent);
    });

    expect(input?.value).toBe('49.12346, 37.23457');
    expect(container.textContent).toContain('Координата вже є у списку');
    expect(container.textContent).not.toContain(
      'Enter — додати; можна вставити одразу декілька координат',
    );
    expect(container.querySelector('[data-coordinate-duplicate="true"]')?.textContent).toContain(
      '49.12346, 37.23457',
    );
    expect(input?.getAttribute('aria-invalid')).not.toBe('true');
    expect(onChange).not.toHaveBeenCalled();
    expect(onErrorChange).toHaveBeenLastCalledWith(null);

    await act(async () => root.unmount());
  });

  it('shows the duplicate notice while the coordinate is being entered', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CoordinateListInput
          value="49.123457, 37.234568"
          onChange={vi.fn()}
          onBlur={vi.fn()}
          onErrorChange={vi.fn()}
          disabled={false}
        />,
      );
    });

    const input = container.querySelector<HTMLInputElement>('input');
    await act(async () => {
      const setInputValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      if (input) setInputValue?.call(input, '49.12346, 37.23457');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    expect(container.textContent).toContain('Координата вже є у списку');
    expect(container.textContent).not.toContain(
      'Enter — додати; можна вставити одразу декілька координат',
    );
    expect(container.querySelector('[data-coordinate-duplicate="true"]')?.textContent).toContain(
      '49.12346, 37.23457',
    );

    await act(async () => root.unmount());
  });
});
