/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GoiSettingsPage } from './index';

type Rendered = {
  container: HTMLDivElement;
  root: Root;
};

const rendered: Rendered[] = [];

const mocks = vi.hoisted(() => ({
  fetchCurrentUser: vi.fn(),
  fetchCurrentUserGoiIntegrations: vi.fn(),
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
  updateCurrentUserGoiDisableSync: vi.fn(),
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
    mocks.fetchCurrentUserGoiIntegrations.mockResolvedValue([
      {
        id: 7,
        ownerOrganismId: 1,
        ownerOrganismName: 'Організм',
        integrationType: 'full',
        serverLabel: 'Сервер ГОІ',
        goiUrl: 'https://goi.example',
        swappUrl: null,
        hasDataAccess: true,
        disableSync: false,
        canChangeDisableSync: true,
        canRestart: true,
        restartUnavailableReason: null,
      },
    ]);
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
    expect(container.textContent).toContain('Додаткові Налаштування');
    expect(container.textContent).toContain('Відключити синхронізацію');
  });
});
