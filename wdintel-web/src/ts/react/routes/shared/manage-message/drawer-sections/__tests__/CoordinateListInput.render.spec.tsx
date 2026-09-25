/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const copyTextToClipboard = vi.hoisted(() => vi.fn());

vi.mock('../../../../../../copy-to-clipboard', () => ({ copyTextToClipboard }));

import { CoordinateListInput } from '../CoordinateListInput';
describe('CoordinateListInput feedback', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    copyTextToClipboard.mockReset();
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

    const input = container.querySelector<HTMLTextAreaElement>('textarea');
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
      '37U CQ 71194 42680',
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

    const input = container.querySelector<HTMLTextAreaElement>('textarea');
    await act(async () => {
      const setInputValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
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
      '37U CQ 71194 42680',
    );

    await act(async () => root.unmount());
  });

  it('keeps and rejects a paste containing an unparsed coordinate', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onChange = vi.fn();
    const onErrorChange = vi.fn();
    const pasted = '49.12345, 37.12345\nunsupported coordinate';

    await act(async () => {
      root.render(
        <CoordinateListInput
          value=""
          onChange={onChange}
          onBlur={vi.fn()}
          onErrorChange={onErrorChange}
          disabled={false}
        />,
      );
    });

    const input = container.querySelector<HTMLTextAreaElement>('textarea');
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { getData: () => pasted },
    });
    await act(async () => {
      input?.dispatchEvent(pasteEvent);
    });

    expect(input?.value).toBe(pasted);
    expect(input?.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('Не вдалося розпізнати всі координати');
    expect(onChange).not.toHaveBeenCalled();
    expect(onErrorChange).toHaveBeenLastCalledWith('Не вдалося розпізнати всі координати');

    await act(async () => root.unmount());
  });

  it('renders every saved coordinate in MGRS format', async () => {
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

    expect(container.textContent).toContain('37U CQ 71194 42680');
    expect(container.textContent).not.toContain('49.12346, 37.23457');

    await act(async () => root.unmount());
  });

  it.each([
    ['MGRS', '37U CQ 71194 42680'],
    ['UTM', '36U 350000 5500000'],
  ])('renders a saved %s coordinate as MGRS', async (_format, value) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CoordinateListInput
          value={value}
          onChange={vi.fn()}
          onBlur={vi.fn()}
          onErrorChange={vi.fn()}
          disabled={false}
        />,
      );
    });

    const row = container.querySelector(
      'button[aria-label="Видалити координату 1"]',
    )?.parentElement;
    expect(row?.textContent).toMatch(/\d{1,2}[C-HJ-NP-X] [A-Z]{2} \d{5} \d{5}/);

    await act(async () => root.unmount());
  });

  it('renders an exact cross-format duplicate once and a nearby point separately', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <CoordinateListInput
          value={'49.123457, 37.234568\n37U CQ 71194 42680\n49.22346, 37.33457'}
          onChange={vi.fn()}
          onBlur={vi.fn()}
          onErrorChange={vi.fn()}
          disabled={false}
        />,
      );
    });

    expect(container.querySelectorAll('button[aria-label^="Видалити координату"]')).toHaveLength(2);

    await act(async () => root.unmount());
  });

  it('copies the displayed MGRS coordinate and confirms success', async () => {
    copyTextToClipboard.mockResolvedValue(undefined);
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

    const copyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Копіювати координату 1"]',
    );
    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
    });

    expect(copyTextToClipboard).toHaveBeenCalledWith('37U CQ 71194 42680');
    expect(copyButton?.querySelector('[data-testid="CheckIcon"]')).not.toBeNull();
    expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(
      'Скопійовано',
    );

    await act(async () => root.unmount());
  });

  it('keeps the full MGRS and compact actions on one row', async () => {
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

    const copyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Копіювати координату 1"]',
    );
    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Видалити координату 1"]',
    );
    const copyIcon = copyButton?.querySelector<SVGElement>('[data-testid="ContentCopyIcon"]');
    const deleteIcon = deleteButton?.querySelector<SVGElement>('[data-testid="DeleteOutlineIcon"]');
    const mgrsText = container.querySelector<HTMLElement>('[title="37U CQ 71194 42680"]');
    const coordinateRow = mgrsText?.parentElement;

    expect(copyButton).not.toBeNull();
    expect(deleteButton).not.toBeNull();
    expect(mgrsText?.textContent).toBe('37U CQ 71194 42680');
    expect(window.getComputedStyle(mgrsText!).whiteSpace).toBe('nowrap');
    expect(window.getComputedStyle(coordinateRow!).gap).toBe('0px');
    expect(window.getComputedStyle(coordinateRow!).paddingLeft).toBe('4px');
    expect(window.getComputedStyle(copyButton!).paddingLeft).toBe('4px');
    expect(window.getComputedStyle(deleteButton!).paddingLeft).toBe('4px');
    expect(copyButton?.parentElement).toBe(deleteButton?.parentElement);
    expect(window.getComputedStyle(copyButton!).width).toBe(
      window.getComputedStyle(deleteButton!).width,
    );
    expect(window.getComputedStyle(copyButton!).height).toBe(
      window.getComputedStyle(deleteButton!).height,
    );
    expect(deleteIcon).not.toBeNull();
    expect(window.getComputedStyle(copyIcon!).fontSize).toBe(
      window.getComputedStyle(deleteIcon!).fontSize,
    );
    expect(window.getComputedStyle(copyIcon!).transform).toBe('scale(0.82)');

    await act(async () => root.unmount());
  });

  it('shows copy failure feedback', async () => {
    copyTextToClipboard.mockRejectedValue(new Error('denied'));
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

    const copyButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Копіювати координату 1"]',
    );
    await act(async () => {
      copyButton?.click();
      await Promise.resolve();
    });

    expect(copyButton?.querySelector('[data-testid="ErrorOutlineIcon"]')).not.toBeNull();
    expect(container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe(
      'Не вдалося скопіювати',
    );

    await act(async () => root.unmount());
  });
});
