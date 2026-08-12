/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUnitDuplicates: vi.fn(),
  mergeDuplicateUnit: vi.fn(),
}));

vi.mock('../../services/api/units', () => mocks);

import { AdminUnitDuplicatesPage } from './index';

describe('AdminUnitDuplicatesPage', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
      },
    });
    mocks.getUnitDuplicates.mockReset().mockResolvedValue([]);
    mocks.mergeDuplicateUnit.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the page while duplicates are loading', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<AdminUnitDuplicatesPage authUserRoles={[]} />));

    expect(container.textContent).toContain('Дублікати Підрозділів');
    await act(async () => root.unmount());
  });
});
