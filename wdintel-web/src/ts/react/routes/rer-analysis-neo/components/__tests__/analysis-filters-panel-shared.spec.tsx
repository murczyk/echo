/**
 * @vitest-environment happy-dom
 */
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { FilterSection } from '../analysis-filters-panel-shared';

function Filters() {
  const [expanded, setExpanded] = useState(false);
  return (
    <FilterSection title="Підрозділи" expanded={expanded} onToggle={() => setExpanded(!expanded)}>
      <input aria-label="Пошук підрозділу" defaultValue="" />
    </FilterSection>
  );
}

it('#4019 mounts filter fields on first expansion and preserves their input on reopening', async () => {
  vi.useFakeTimers();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Filters />));
    expect(container.querySelector('input')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('button');
    expect(toggle).not.toBeNull();
    await act(async () => toggle?.click());
    const input = container.querySelector<HTMLInputElement>('input');
    expect(input).not.toBeNull();
    input!.value = 'пошук';
    await act(async () => toggle?.click());
    await act(async () => vi.runAllTimersAsync());
    expect(container.querySelector('input')).toBe(input);
    await act(async () => toggle?.click());
    expect(container.querySelector<HTMLInputElement>('input')?.value).toBe('пошук');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  }
});
