/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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

let renderedRoot: Root | null = null;

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  renderedRoot = root;
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

function setInputValue(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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
    act(() => renderedRoot?.unmount());
    renderedRoot = null;
    document.body.innerHTML = '';
    delete (window as { localStorage?: Storage }).localStorage;
  });

  // @test-scope regression: https://github.com/echoua/echo/pull/3268
  it('keeps a dirty drawer open when dismissal is declined', async () => {
    const { root } = await renderPage();
    await clickButton('Редагувати');
    const host = document.querySelector<HTMLInputElement>('input[value="goi-9.local"]');
    expect(host).not.toBeNull();
    await act(async () => {
      setInputValue(host!, 'draft');
    });
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => false) });
    await clickButton('Скасувати');
    expect(window.confirm).toHaveBeenCalled();
    expect(document.body.textContent).toContain('Редагувати інтеграцію ГОІ');
    await act(async () => root.unmount());
  });

  // @test-scope regression: https://github.com/echoua/echo/pull/3268
  it('refreshes the clean drawer baseline after worker setup', async () => {
    const configured = {
      ...integration,
      serverLabel: 'goi-configured',
      sshHost: 'goi-configured.local',
      apiPassword: 'generated-secret',
    };
    mocks.setupWorker.mockResolvedValue(configured);
    Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn(() => true) });
    const { container, root } = await renderPage();
    await clickButton('Редагувати');
    await clickButton('Налаштувати воркер');

    expect(mocks.setupWorker).toHaveBeenCalledWith(
      expect.objectContaining({ id: integration.id, sshHost: integration.sshHost }),
    );
    expect(
      document.querySelector<HTMLInputElement>('input[value="goi-configured.local"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain(configured.serverLabel);

    await clickButton('Скасувати');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => root.unmount());
  });

  // @test-scope regression: https://github.com/echoua/echo/pull/3268
  it('prevents drawer dismissal while a connection check is running', async () => {
    let finishCheck:
      ((value: { ok: boolean; error: string | null; listedEntries: string[] }) => void) | null =
      null;
    mocks.check.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishCheck = resolve;
        }),
    );
    const { root } = await renderPage();
    await clickButton('Редагувати');
    await act(async () => button("Перевірити з'єднання")?.click());
    expect(button('Скасувати')?.disabled).toBe(true);
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.body.textContent).toContain('Редагувати інтеграцію ГОІ');

    await act(async () => finishCheck?.({ ok: true, error: null, listedEntries: [] }));
    await act(async () => Promise.resolve());
    expect(button('Скасувати')?.disabled).toBe(false);

    await act(async () => root.unmount());
  });

  // @test-scope safeguard: prevents a GOI integration overflow action from deleting a record other than the selected ID
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
