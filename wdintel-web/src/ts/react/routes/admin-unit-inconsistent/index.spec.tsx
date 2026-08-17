/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getInconsistentUnits: vi.fn(),
}));

vi.mock('../../services/api/units', () => mocks);

import { AdminUnitInconsistentPage } from './index';

describe('AdminUnitInconsistentPage', () => {
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
    mocks.getInconsistentUnits.mockReset().mockResolvedValue([
      {
        sigintUnitId: 42,
        name: 'Test unit',
        reasons: ['Кілька прив’язок ORBIT'],
        problematicEchelons: ['Рота'],
      },
    ]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('explains inconsistency and renders its reasons', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<AdminUnitInconsistentPage />));
    await vi.waitFor(() => expect(container.textContent).toContain('Test unit'));

    expect(container.textContent).toContain('Чому підрозділи потрапляють до цього списку');
    expect(container.textContent).toContain('Кілька прив’язок ORBIT');
    expect(container.textContent).toContain('Рота');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/rer-units/42');
    await act(async () => root.unmount());
  });

  it('shows API errors', async () => {
    mocks.getInconsistentUnits.mockRejectedValueOnce(new Error('Load failed'));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<AdminUnitInconsistentPage />));
    await vi.waitFor(() => expect(container.textContent).toContain('Load failed'));

    await act(async () => root.unmount());
  });
});
