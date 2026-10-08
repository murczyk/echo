/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const currentSystemSettings = vi.hoisted(() => vi.fn());
const setRerReportEnabled = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
const listLogins = vi.hoisted(() => vi.fn());
const rerReportApi = vi.hoisted(() => ({
  getAccessList: vi.fn(),
  listMetadata: vi.fn(),
  replaceAccessList: vi.fn(),
}));

vi.mock('../../../components/PageHeader', () => ({
  PageHeader: ({ title, titleActions }: { title: string; titleActions: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {titleActions}
    </header>
  ),
}));
vi.mock('../../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify }),
}));
vi.mock('../../../services/api/system-settings', () => ({
  currentSystemSettings,
  setRerReportEnabled,
}));
vi.mock('../../../services/api/logins', () => ({ listLogins }));
vi.mock('../../../services/api/rer-report-admin', () => ({
  getRerReportAccessList: rerReportApi.getAccessList,
  listRerReportMetadata: rerReportApi.listMetadata,
  replaceRerReportAccessList: rerReportApi.replaceAccessList,
}));
vi.mock('../RerReportMetadataTable', () => ({
  RerReportMetadataTable: ({ disabled }: { disabled: boolean }) => (
    <div data-testid="metadata-table" data-disabled={String(disabled)} />
  ),
}));
vi.mock('../../settings-neo/SettingsMyReportsSection', () => ({
  ReportHistoryTableSection: ({ showTitle }: { showTitle: boolean }) => (
    <div data-testid="reports" data-show-title={String(showTitle)} />
  ),
}));

import { AdminAllReportsPage, readAdminAllReportsTab } from '..';

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  window.history.replaceState(null, '', '/admin/all-reports');
  vi.clearAllMocks();
});

describe('AdminAllReportsPage', () => {
  // Regression: https://github.com/echoua/echo/issues/3598
  it('keeps unavailable accounts removable and preserves unsaved selections across retry', async () => {
    window.history.replaceState(null, '', '/admin/all-reports?tab=rer-report');
    currentSystemSettings.mockResolvedValue({ rerReportEnabled: true });
    listLogins.mockResolvedValue({ users: [] });
    rerReportApi.getAccessList.mockResolvedValue({ loginIds: ['missing-login'] });
    rerReportApi.listMetadata.mockResolvedValue([]);
    rerReportApi.listMetadata.mockRejectedValueOnce(new Error('Metadata unavailable'));
    rerReportApi.replaceAccessList.mockResolvedValue({ loginIds: [] });
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<AdminAllReportsPage />));
    expect(container.textContent).toContain('Недоступний користувач (missing-login)');
    const remove = container.querySelector('[data-testid="CancelIcon"]');
    expect(remove).not.toBeNull();
    await act(async () => remove?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Повторити завантаження',
    );
    await act(async () => retry?.click());
    expect(container.textContent).not.toContain('Недоступний користувач (missing-login)');
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Зберегти список',
    );
    expect(save?.disabled).toBe(false);
    await act(async () => save?.click());
    expect(rerReportApi.replaceAccessList).toHaveBeenCalledWith({ loginIds: [] });
  });

  // Regression: https://github.com/echoua/echo/issues/3598
  it('preserves shared metadata filters when opening and switching tabs', async () => {
    window.history.replaceState(null, '', '/admin/all-reports?tab=rer-report&globalFilter=unit');
    currentSystemSettings.mockResolvedValue({ rerReportEnabled: true });
    listLogins.mockResolvedValue({ users: [] });
    rerReportApi.getAccessList.mockResolvedValue({ loginIds: [] });
    rerReportApi.listMetadata.mockResolvedValue([]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<AdminAllReportsPage />));
    expect(new URLSearchParams(window.location.search).get('globalFilter')).toBe('unit');
    const allTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Всі звіти',
    );
    await act(async () => allTab?.click());
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('all');
    expect(new URLSearchParams(window.location.search).get('globalFilter')).toBe('unit');
  });

  // Regression: https://github.com/echoua/echo/issues/3598
  it.each(['logins', 'access', 'metadata'])(
    'preserves saved settings and retries a failed %s load',
    async (failedSection) => {
      window.history.replaceState(null, '', '/admin/all-reports?tab=rer-report');
      currentSystemSettings.mockResolvedValue({ rerReportEnabled: true });
      listLogins.mockResolvedValue({ users: [] });
      rerReportApi.getAccessList.mockResolvedValue({ loginIds: [] });
      rerReportApi.listMetadata.mockResolvedValue([]);
      const failedRequest = {
        logins: listLogins,
        access: rerReportApi.getAccessList,
        metadata: rerReportApi.listMetadata,
      }[failedSection]!;
      failedRequest.mockRejectedValueOnce(new Error('Load failed'));
      const container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      await act(async () => root?.render(<AdminAllReportsPage />));

      const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(toggle?.checked).toBe(true);
      expect(toggle?.disabled).toBe(false);
      expect(container.querySelector<HTMLInputElement>('input[role="combobox"]')?.disabled).toBe(
        failedSection !== 'metadata',
      );
      expect(
        container.querySelector('[data-testid="metadata-table"]')?.getAttribute('data-disabled'),
      ).toBe(String(failedSection === 'metadata'));
      expect(notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
      const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Повторити завантаження',
      );
      expect(retry).toBeDefined();
      await act(async () => retry?.click());
      expect(container.textContent).not.toContain('Повторити завантаження');
      expect(container.querySelector<HTMLInputElement>('input[role="combobox"]')?.disabled).toBe(
        false,
      );
      expect(
        container.querySelector('[data-testid="metadata-table"]')?.getAttribute('data-disabled'),
      ).toBe('false');
    },
  );

  // Regression: https://github.com/echoua/echo/issues/3598
  it('prevents toggling unknown persisted settings until retry succeeds', async () => {
    window.history.replaceState(null, '', '/admin/all-reports?tab=rer-report');
    currentSystemSettings.mockResolvedValue({ rerReportEnabled: true });
    currentSystemSettings.mockRejectedValueOnce(new Error('Settings unavailable'));
    listLogins.mockResolvedValue({ users: [] });
    rerReportApi.getAccessList.mockResolvedValue({ loginIds: [] });
    rerReportApi.listMetadata.mockResolvedValue([]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<AdminAllReportsPage />));
    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.disabled).toBe(true);
    await act(async () => toggle?.click());
    expect(setRerReportEnabled).not.toHaveBeenCalled();
    const retry = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Повторити завантаження',
    );
    await act(async () => retry?.click());
    expect(toggle?.disabled).toBe(false);
    expect(toggle?.checked).toBe(true);
  });

  it('reads supported tabs and falls back to all reports', () => {
    expect(readAdminAllReportsTab('?tab=rer-report')).toBe('rer-report');
    expect(readAdminAllReportsTab('?tab=unknown')).toBe('all');
  });

  it('renders tabs without a duplicate report title and saves the RER toggle', async () => {
    currentSystemSettings.mockResolvedValue({ rerReportEnabled: false });
    setRerReportEnabled.mockResolvedValue({ rerReportEnabled: true });
    listLogins.mockResolvedValue({ users: [] });
    rerReportApi.getAccessList.mockResolvedValue({ loginIds: [] });
    rerReportApi.listMetadata.mockResolvedValue([]);
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => root?.render(<AdminAllReportsPage />));
    expect(
      container.querySelector('[data-testid="reports"]')?.getAttribute('data-show-title'),
    ).toBe('false');

    const rerTab = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Звіт РЕР',
    );
    await act(async () => rerTab?.click());
    await act(async () => Promise.resolve());

    const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(toggle?.checked).toBe(false);
    expect(container.textContent).toContain('Працює над звітом РЕР');
    expect(container.querySelector('[data-testid="metadata-table"]')).not.toBeNull();
    await act(async () => toggle?.click());

    expect(setRerReportEnabled).toHaveBeenCalledWith(true);
    expect(notify).toHaveBeenCalledWith({
      severity: 'success',
      message: 'Налаштування звіту РЕР збережено.',
    });
  });
});
