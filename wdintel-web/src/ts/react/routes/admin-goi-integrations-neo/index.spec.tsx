/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
  check: vi.fn(),
  setupWorker: vi.fn(),
  listOrganisms: vi.fn(),
  listLogins: vi.fn(),
}));

vi.mock('../../services/api/goi-admin', () => ({
  listGoiAdminIntegrations: mocks.list,
  upsertGoiAdminIntegration: mocks.upsert,
  deleteGoiAdminIntegration: mocks.remove,
  checkGoiConnection: mocks.check,
  setupGoiIntegrationWorker: mocks.setupWorker,
}));
vi.mock('../../services/api/organisms', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/api/organisms')>()),
  listOrganisms: mocks.listOrganisms,
}));
vi.mock('../../services/api/logins', () => ({
  listLogins: mocks.listLogins,
}));

import { AdminGoiIntegrationsNeoPage } from './index';

const integration = {
  id: 3,
  ownerOrganismId: 9,
  ownerOrganismName: 'Організм 9',
  createdAtMs: 1,
  integrationType: 'full',
  serverLabel: 'goi-9',
  sshHost: 'goi-9.local',
  sshUser: 'goi',
  sshPort: 22,
  path: '/etc/goi/data/palettes',
  apiHost: 'goi-9.local',
  apiPort: 8088,
  apiLogin: 'goi',
  apiPassword: 'secret',
  disableGoiToEchoPalitraSync: true,
  pauseWorker: false,
  maintainerLoginId: '',
  accessOrganismIds: [],
  accessLogins: [],
};

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<AdminGoiIntegrationsNeoPage />));
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

describe('AdminGoiIntegrationsNeoPage', () => {
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
    mocks.listOrganisms.mockReset().mockResolvedValue([{ id: 9, name: 'Організм 9' }]);
    mocks.listLogins.mockReset().mockResolvedValue({ users: [] });
    mocks.upsert.mockReset();
    mocks.remove.mockReset().mockResolvedValue(undefined);
    mocks.check.mockReset();
    mocks.setupWorker.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete (window as { localStorage?: Storage }).localStorage;
  });

  it('renders the standard table and create/edit dialogs', async () => {
    const { container, root } = await renderPage();

    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).toContain('Організм 9');
    await clickButton('Додати інтеграцію');
    expect(document.body.textContent).toContain('Створити інтеграцію ГОІ');
    await clickButton('Скасувати');
    await clickButton('Редагувати');
    expect(document.body.textContent).toContain('Редагувати інтеграцію ГОІ');

    await act(async () => root.unmount());
  });

  it('deletes through the row overflow action', async () => {
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
    await clickButton('Видалити');
    expect(mocks.remove).toHaveBeenCalledWith(integration.id);
    expect(container.textContent).not.toContain('goi-9');

    await act(async () => root.unmount());
  });
});
