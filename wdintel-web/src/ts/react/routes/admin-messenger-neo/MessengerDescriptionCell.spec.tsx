/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NeoMuiThemeProvider } from '../../mui-theme';
import { validateMrtColumnPolicies } from '../../components/mui-customized/table/get-default-table-options';
import { createMessengerDescriptionColumn } from './index';
import { MessengerDescriptionCell } from './MessengerDescriptionCell';

describe('MessengerDescriptionCell', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalClientWidth: PropertyDescriptor | undefined;
  let originalScrollWidth: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 80,
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => 240,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalClientWidth)
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    if (originalScrollWidth)
      Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('bounds description and Echo endpoint lines while disclosing their complete values', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await act(async () => {
        root.render(
          <NeoMuiThemeProvider>
            <MessengerDescriptionCell
              description="Дуже довгий опис акаунта, який має залишитися одним рядком"
              endpoint="https://echo.example.test/very-long-unbroken-endpoint-value"
              showEndpoint
            />
          </NeoMuiThemeProvider>,
        );
      });

      const description = Array.from(
        container.querySelectorAll<HTMLElement>('[tabindex="0"]'),
      ).find((element) => element.textContent?.startsWith('Дуже довгий опис'));
      const endpoint = Array.from(container.querySelectorAll<HTMLElement>('[tabindex="0"]')).find(
        (element) => element.textContent?.startsWith('Endpoint:'),
      );
      if (!description || !endpoint) throw new Error('Expected bounded description lines');

      for (const line of [description, endpoint]) {
        const styles = getComputedStyle(line);
        expect(styles.whiteSpace).toBe('nowrap');
        expect(styles.overflow).toBe('hidden');
        expect(styles.textOverflow).toBe('ellipsis');
      }
      expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(2);

      act(() => description.focus());
      await act(async () => vi.runAllTimers());
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Дуже довгий опис акаунта, який має залишитися одним рядком',
      );
      act(() => description.blur());
      act(() => description.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })));
      await act(async () => vi.runAllTimers());
      act(() => endpoint.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
      await act(async () => vi.runAllTimers());
      expect(
        Array.from(document.body.querySelectorAll('[role="tooltip"]')).find(
          (tooltip) =>
            tooltip.textContent ===
            'Endpoint: https://echo.example.test/very-long-unbroken-endpoint-value',
        ),
      ).not.toBeNull();
    } finally {
      const output = errors.mock.calls.map((args) => args.map(String).join(' ')).join('\n');
      errors.mockRestore();
      expect(output).not.toMatch(/warning|error|invalid prop|aria|nesting/i);
    }
  });

  it('omits non-Echo endpoints, retains empty descriptions, and uses a valid custom column', async () => {
    await act(async () => {
      root.render(
        <NeoMuiThemeProvider>
          <MessengerDescriptionCell
            description="   "
            endpoint="https://echo.example.test/hidden"
            showEndpoint={false}
          />
        </NeoMuiThemeProvider>,
      );
    });

    expect(container.textContent).toContain('—');
    expect(container.textContent).not.toContain('Endpoint:');
    expect(validateMrtColumnPolicies([createMessengerDescriptionColumn()])).toEqual([]);
  });
});
