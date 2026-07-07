/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoiSettingsPage } from './index';
import type { GoiUserIntegration } from '../../services/api/goi-settings';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];
function makeIntegration(overrides: Partial<GoiUserIntegration> = {}): GoiUserIntegration {
  return {
    id: 7,
    ownerOrganismId: 1,
    ownerOrganismName: 'Організм',
    integrationType: 'full',
    serverLabel: 'Сервер ГОІ',
    goiUrl: 'https://goi.example',
    swappUrl: null,
    hasDataAccess: true,
    pauseWorker: false,
    canChangePauseWorker: true,
    canRestart: true,
    restartUnavailableReason: null,
    ...overrides,
  };
}

const mocks = vi.hoisted(() => ({
  fetchCurrentUser: vi.fn(),
  fetchCurrentUserGoiIntegrations: vi.fn(),
  updateCurrentUserGoiPauseWorker: vi.fn(),
}));

vi.mock('../../services/api/user', () => ({
  fetchCurrentUser: (...args: unknown[]) => mocks.fetchCurrentUser(...args),
}));

vi.mock('../../services/api/goi-settings', () => ({
  downloadCurrentUserGoiPalettes: vi.fn(),
  fetchCurrentUserGoiIntegrations: (...args: unknown[]) =>
    mocks.fetchCurrentUserGoiIntegrations(...args),
  fetchGoiReportTabOrder: vi.fn().mockResolvedValue([]),
  restartCurrentUserGoiService: vi.fn(),
  unlinkCurrentUserGoiWhatsapp: vi.fn(),
  updateCurrentUserGoiPauseWorker: (...args: unknown[]) =>
    mocks.updateCurrentUserGoiPauseWorker(...args),
  updateGoiReportTabOrder: vi.fn(),
  uploadCurrentUserGoiCategories: vi.fn(),
}));

vi.mock('../../components/PageHeader', () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('../../components/PowerButton', () => ({
  PowerButton: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock('./GoiReportTabOrderSection', () => ({
  GoiReportTabOrderSection: () => <div>Порядок вкладок у звіті ГОІ</div>,
}));

function getSyncCheckbox(): HTMLInputElement {
  const checkbox = document.body.querySelector<HTMLInputElement>(
    'input[aria-label="Призупинити синхронізацію"]',
  );
  if (!checkbox) throw new Error('Sync checkbox not found');
  return checkbox;
}

function getButtonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find(
    (item) => item.textContent === text,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
  return button;
}

async function renderComponent() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  rendered.push({ container, root });

  await act(async () => {
    root.render(<GoiSettingsPage />);
  });

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

  return { container, root };
}

describe('GoiSettingsPage', () => {
  beforeEach(() => {
    mocks.fetchCurrentUser.mockResolvedValue({
      name: 'admin',
      roles: ['Admin'],
      sigintZoneId: null,
      organismId: 1,
      deltaLogin: null,
      goiConfiguredForOrganism: true,
      goiFullAccessForOrganism: true,
      goiHost: null,
      goiIntegrations: [],
      lastReleaseSeen: null,
    });
    mocks.fetchCurrentUserGoiIntegrations.mockResolvedValue([makeIntegration()]);
    mocks.updateCurrentUserGoiPauseWorker.mockImplementation(
      (integrationId: number, pauseWorker: boolean) =>
        Promise.resolve(makeIntegration({ id: integrationId, pauseWorker })),
    );
  });

  afterEach(() => {
    for (const item of rendered.splice(0)) {
      act(() => {
        item.root.unmount();
      });
      item.container.remove();
    }
    vi.clearAllMocks();
  });

  it('loads current-user integrations for admin users', async () => {
    const { container } = await renderComponent();

    expect(mocks.fetchCurrentUserGoiIntegrations).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Сервер ГОІ');
    expect(container.textContent).toContain('Додаткові функції');
    expect(container.textContent).not.toContain('Додаткові Налаштування');
    expect(container.textContent).toContain('Призупинити синхронізацію');
  });

  it('asks for confirmation before pausing sync', async () => {
    await renderComponent();

    await act(async () => {
      getSyncCheckbox().click();
    });

    expect(document.body.textContent).toContain('Ви впевнені?');
    expect(document.body.textContent).toContain(
      "Дана дія зупинить підвантаження нових палітр, позивних, прив'язок частот із ЕХО",
    );
    expect(document.body.textContent).toContain('Підтвердити');
    expect(document.body.textContent).toContain('Скасувати');
    expect(mocks.updateCurrentUserGoiPauseWorker).not.toHaveBeenCalled();

    await act(async () => {
      getButtonByText('Підтвердити').click();
      await Promise.resolve();
    });

    expect(mocks.updateCurrentUserGoiPauseWorker).toHaveBeenCalledWith(7, true);
  });

  it('asks for confirmation before resuming sync', async () => {
    mocks.fetchCurrentUserGoiIntegrations.mockResolvedValue([
      makeIntegration({ pauseWorker: true }),
    ]);
    await renderComponent();

    await act(async () => {
      getSyncCheckbox().click();
    });

    expect(document.body.textContent).toContain(
      "Дана дія може стерти ваші дані (позивні, прив'язки частот) із ГОІ",
    );

    await act(async () => {
      getButtonByText('Скасувати').click();
    });

    expect(mocks.updateCurrentUserGoiPauseWorker).not.toHaveBeenCalled();
  });
});
