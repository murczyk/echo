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
  RerReportMetadataTable: () => <div data-testid="metadata-table" />,
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
