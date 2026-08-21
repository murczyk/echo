/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

import { NeoMuiThemeProvider } from '../mui-theme';
import { PowerChip } from './PowerChip';

const mounted: Array<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> = [];

afterEach(() => {
  mounted.splice(0).forEach(({ container, root }) => {
    act(() => root.unmount());
    container.remove();
  });
});

function render(node: ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(NeoMuiThemeProvider, null, node)));
  mounted.push({ container, root });
  return container;
}

it('uses 14px small MUI chips while preserving chip behavior', () => {
  const onClick = vi.fn();
  const onDelete = vi.fn();
  const container = render(
    createElement(
      'div',
      null,
      createElement(PowerChip, { label: 'read-only' }),
      createElement(PowerChip, { label: 'selected', selected: true, onClick }),
      createElement(PowerChip, { label: 'link', href: '/details' }),
      createElement(PowerChip, { label: 'delete', onDelete }),
      createElement(PowerChip, {
        label: 'custom color',
        backgroundColor: '#123456',
        selectedTextColor: '#ffffff',
        selected: true,
      }),
    ),
  );
  const chips = [...container.querySelectorAll<HTMLElement>('.MuiChip-root')];
  const [readOnly, selected, link, deletable, custom] = chips;

  expect(chips).toHaveLength(5);
  chips.forEach((chip) => expect(getComputedStyle(chip).fontSize).toBe('14px'));
  expect(readOnly?.classList.contains('MuiChip-sizeSmall')).toBe(true);
  expect(readOnly?.classList.contains('MuiChip-outlined')).toBe(true);
  expect(selected?.classList.contains('MuiChip-filled')).toBe(true);
  expect(link?.tagName).toBe('A');
  expect(link?.getAttribute('href')).toBe('/details');
  expect(custom?.textContent).toContain('custom color');

  act(() => selected?.click());
  expect(onClick).toHaveBeenCalledTimes(1);
  act(() =>
    deletable
      ?.querySelector<SVGElement>('.MuiChip-deleteIcon')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  expect(onDelete).toHaveBeenCalledTimes(1);
});
