/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';

import { EchoChip } from './EchoChip';

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
  act(() => root.render(node));
  mounted.push({ container, root });
  return container;
}

it('uses native read-only, button, and link semantics without making read-only chips tabbable', () => {
  const onClick = () => undefined;
  const container = render(
    createElement(
      'div',
      null,
      createElement(EchoChip, { label: 'read-only' }),
      createElement(EchoChip, { label: 'action', onClick, tone: 'primary', selected: true }),
      createElement(EchoChip, { label: 'link', href: '/details' }),
    ),
  );

  const [readOnly, button, link] = [...container.querySelectorAll<HTMLElement>('.echo-chip')];
  expect(readOnly?.tagName).toBe('SPAN');
  expect(readOnly?.tabIndex).toBe(-1);
  expect(button?.tagName).toBe('BUTTON');
  expect(button?.getAttribute('type')).toBe('button');
  expect(button?.getAttribute('data-selected')).toBe('true');
  expect(link?.tagName).toBe('A');
  expect(link?.getAttribute('href')).toBe('/details');
});

it('keeps table and tag appearances explicit without consumer color overrides', () => {
  const container = render(
    createElement(
      'div',
      null,
      createElement(EchoChip, { label: 'primary', tone: 'primary' }),
      createElement(EchoChip, { label: 'selected-neutral', tone: 'neutral', selected: true }),
      createElement(EchoChip, { label: 'tag', tone: 'tag', selected: true }),
    ),
  );

  const [primary, neutral, tag] = [...container.querySelectorAll<HTMLElement>('.echo-chip')];
  expect(primary?.classList.contains('echo-chip--primary')).toBe(true);
  expect(neutral?.classList.contains('echo-chip--neutral')).toBe(true);
  expect(neutral?.getAttribute('data-selected')).toBe('true');
  expect(tag?.classList.contains('echo-chip--tag')).toBe(true);
  expect(tag?.className).not.toContain('text-primary');
});
