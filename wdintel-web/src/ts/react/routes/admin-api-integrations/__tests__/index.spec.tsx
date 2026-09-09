/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  testConnection: vi.fn(),
  listLogins: vi.fn(),
}));

vi.mock('../../../services/api/api-integrations', () => ({
  listApiIntegrations: mocks.list,
  upsertApiIntegration: mocks.upsert,
  deleteApiIntegration: mocks.remove,
  testConnection: mocks.testConnection,
}));
vi.mock('../../../services/api/logins', () => ({
  listLogins: mocks.listLogins,
}));

import { AdminApiIntegrationsPage } from '.././index';

const integration = {
  id: 7,
  description: 'Аналітика',
  apiUserLoginId: '01900000-0000-7000-8000-000000000001',
  hasIggyConnection: false,
  iggyUrl: null,
  iggyLogin: null,
  iggyPassword: null,
  iggyInboxTopic: null,
  iggyAnalyticsTopic: null,
  syncEnabled: false,
  lastSyncAtMs: null,
  isWorking: true,
  createdAtMs: 1,
};
const apiUser = {
  id: integration.apiUserLoginId,
  login: 'analytics-api',
};

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<AdminApiIntegrationsPage />));
  await act(async () => Promise.resolve());
  await act(async () => Promise.resolve());
  return { container, root };
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label,
  );
}

async function clickButton(label: string) {
  await act(async () => {
    button(label)?.click();
    await new Promise((resolve) => window.setTimeout(resolve, 410));
  });
}

describe('AdminApiIntegrationsPage', () => {
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
    mocks.list.mockReset().mockResolvedValue([integration]);
    mocks.listLogins.mockReset().mockResolvedValue({ users: [apiUser] });
    mocks.upsert.mockReset();
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.testConnection.mockReset();
    window.localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as { localStorage?: Storage }).localStorage;
  });

  // @test-scope safeguard: prevents accidental deletion of an API integration before the explicit confirmation action.
  it('deletes through the overflow action and confirmation dialog', async () => {
    const { container, root } = await renderPage();

    await clickButton('Дії');
    const deleteItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.trim() === 'Видалити',
    );
    expect(deleteItem).toBeDefined();
    await act(async () => {
      deleteItem?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 410));
    });
    expect(mocks.remove).not.toHaveBeenCalled();
    await clickButton('Видалити');
    expect(mocks.remove).toHaveBeenCalledWith(integration.id);
    expect(container.textContent).not.toContain('Аналітика');

    await act(async () => root.unmount());
  });
});
