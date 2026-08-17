/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { ZoneGroupCell } from './ZoneGroupCell';

it('keeps a secret group indicator beside its navigable name', () => {
  const onView = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(createElement(ZoneGroupCell, { name: 'Однакова група', isSecret: true, onView })),
  );
  expect(container.textContent).toContain('Однакова група');
  expect(container.textContent).toContain('прихована');
  act(() => container.querySelector<HTMLElement>('button')?.click());
  expect(onView).toHaveBeenCalledTimes(1);
  act(() =>
    root.render(createElement(ZoneGroupCell, { name: 'Відкрита група', isSecret: false, onView })),
  );
  expect(container.textContent).not.toContain('прихована');
  act(() => root.unmount());
  container.remove();
});
