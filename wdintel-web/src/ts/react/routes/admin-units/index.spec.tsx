/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../admin-unit-inconsistent', () => ({
  AdminUnitInconsistentPage: () => <div>Неконсистентні дані</div>,
}));

vi.mock('../admin-unit-duplicates', () => ({
  AdminUnitDuplicatesPage: () => <div>Дублікати дані</div>,
}));

vi.mock('../admin-unit-names', () => ({
  AdminUnitNamesPage: () => <div>Назви дані</div>,
}));

vi.mock('../admin-unit-unparsed', () => ({
  AdminUnitUnparsedPage: () => <div>Нерозпізнані дані</div>,
}));

import { AdminUnitsPage, readAdminUnitsTab } from './index';

describe('admin units routing', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    window.history.replaceState({}, '', '/admin/units');
  });

  it('defaults missing and invalid tabs to duplicates', () => {
    expect(readAdminUnitsTab('')).toBe('duplicates');
    expect(readAdminUnitsTab('?tab=unknown')).toBe('duplicates');
    expect(readAdminUnitsTab('?tab=inconsistent')).toBe('inconsistent');
    expect(readAdminUnitsTab('?tab=names')).toBe('names');
    expect(readAdminUnitsTab('?tab=unparsed')).toBe('unparsed');
  });

  it('replaces an invalid canonical tab without adding history', async () => {
    window.history.replaceState({}, '', '/admin/units?tab=unknown&extra=value');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<AdminUnitsPage authUserRoles={[]} />));
    expect(window.location.pathname + window.location.search).toBe('/admin/units?tab=duplicates');
    await act(async () => root.unmount());
  });

  it.each([
    ['/admin/unit-duplicates', 'duplicates'],
    ['/admin/unit-inconsistent', 'inconsistent'],
    ['/admin/unit-unparsed', 'unparsed'],
  ] as const)('replaces legacy route %s', async (pathname, tab) => {
    window.history.replaceState({}, '', pathname);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<AdminUnitsPage authUserRoles={[]} initialTab={tab} />));
    expect(window.location.pathname + window.location.search).toBe(`/admin/units?tab=${tab}`);
    await act(async () => root.unmount());
  });

  it('pushes tab navigation and follows popstate', async () => {
    window.history.replaceState({}, '', '/admin/units?tab=duplicates');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<AdminUnitsPage authUserRoles={[]} />));
    expect(container.textContent).toContain('Неконсистентні підрозділи');
    expect(container.textContent).toContain('Нерозпізнані підрозділи');
    expect(container.textContent).toContain('Назви підрозділів');
    const inconsistentTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Неконсистентні підрозділи',
    );
    await act(async () => inconsistentTab?.click());
    expect(window.location.search).toBe('?tab=inconsistent');
    const namesTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Назви підрозділів',
    );
    await act(async () => namesTab?.click());
    expect(window.location.search).toBe('?tab=names');
    const unparsedTab = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Нерозпізнані підрозділи',
    );
    await act(async () => unparsedTab?.click());
    expect(window.location.search).toBe('?tab=unparsed');

    window.history.pushState({}, '', '/admin/units?tab=duplicates');
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(container.textContent).toContain('Дублікати підрозділів');

    await act(async () => root.unmount());
  });
});
