/**
 * @vitest-environment happy-dom
 */
import { ThemeProvider } from '@mui/material/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceDetails } from '../../../../Bindings';
import { createNeoMuiTheme } from '../../mui-theme';
import { DeviceDetailsPage } from './index';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const testTheme = createNeoMuiTheme('light');

const pageMock = vi.hoisted(() => ({
  useDeviceDetailsPage: vi.fn(),
  useDeviceFiles: vi.fn(),
  useDeviceFileJournal: vi.fn(),
  useDeviceAnalyticsTags: vi.fn(),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

vi.mock('./use-device-details-page', () => ({
  useDeviceDetailsPage: pageMock.useDeviceDetailsPage,
}));

vi.mock('../device-files/use-device-file-journal', () => ({
  useDeviceFileJournal: pageMock.useDeviceFileJournal,
}));

vi.mock('../device-files/use-device-analytics-tags', () => ({
  useDeviceAnalyticsTags: pageMock.useDeviceAnalyticsTags,
}));

vi.mock('../device-files', () => ({
  useDeviceFiles: pageMock.useDeviceFiles,
  DeviceFilesSidebar: () => <aside data-testid="device-files-sidebar">Бічна панель файлів</aside>,
  DeviceFileContentPane: () => (
    <section data-testid="device-file-content-pane">Вміст файлу</section>
  ),
}));

vi.mock('../device-files/components/DeviceFileJournal', () => ({
  DeviceFileJournal: () => <div data-testid="device-file-journal">Журнал синхронізації</div>,
}));

vi.mock('./components/DeviceAnalyticsPanel', () => ({
  DeviceAnalyticsPanel: ({ isAdmin }: { isAdmin: boolean }) => (
    <div data-testid="device-analytics-panel" data-is-admin={String(isAdmin)}>
      Аналітика файлів
    </div>
  ),
}));

const activeDevice: DeviceDetails = {
  id: DEVICE_ID,
  name: 'Device Alpha',
  aors: [
    { id: 1, name: 'Північ' },
    { id: 2, name: 'Південь' },
  ],
  unit: { id: 7, name: 'Unit Seven' },
  externalUrl: 'https://example.test/device-alpha',
  customFields: { inventory_id: 'node-1' },
  createdBy: 'operator',
  archived: false,
  archivedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
};

function buildPage(overrides: Record<string, unknown> = {}) {
  return {
    permissions: {
      canRead: true,
      canEdit: true,
      fieldPermissions: { sourceData: true, analyticalData: true },
    },
    device: activeDevice,
    loading: false,
    refreshing: false,
    status: null,
    aorOptions: [],
    unitOptions: [],
    lookupsLoading: false,
    editForm: null,
    editError: null,
    editServerFieldErrors: {},
    editSubmitting: false,
    editHasChanges: false,
    initialLoadFailed: false,
    reload: vi.fn(),
    openEditDrawer: vi.fn(),
    closeEditDrawer: vi.fn(),
    setEditForm: vi.fn(),
    saveEditDevice: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  pageMock.useDeviceDetailsPage.mockReturnValue(buildPage());
  pageMock.useDeviceFiles.mockReturnValue({});
  pageMock.useDeviceFileJournal.mockReturnValue({
    entries: [],
    totalCount: null,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
    reload: vi.fn(),
    loadMore: vi.fn(),
  });
  pageMock.useDeviceAnalyticsTags.mockReturnValue({
    tags: [],
    loading: false,
    error: null,
    reload: vi.fn(),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

function renderPage(authUserRoles: string[] = ['DeviceSource']) {
  act(() => {
    root?.render(
      <ThemeProvider theme={testTheme}>
        <DeviceDetailsPage deviceId={DEVICE_ID} authUserRoles={authUserRoles} />
      </ThemeProvider>,
    );
  });
}

describe('DeviceDetailsPage layout', () => {
  it('renders target device metadata and only the supported edit action', () => {
    renderPage();

    const leftPanel = container?.querySelector('[data-testid="device-details-left-panel"]');
    const leftPanelText = leftPanel?.textContent ?? '';
    const deviceNameLink = Array.from(leftPanel?.querySelectorAll('a') ?? []).find(
      (element) => element.textContent === activeDevice.name,
    );

    expect(leftPanelText).toContain('Device Alpha');
    expect(leftPanelText).toContain(DEVICE_ID);
    expect(leftPanelText).toContain('Активний');
    expect(leftPanelText).toContain('Північ');
    expect(leftPanelText).toContain('Південь');
    expect(leftPanelText).toContain('Unit Seven');
    expect(leftPanelText).toContain('operator');
    expect(leftPanelText).not.toContain('Зовнішнє посилання');
    expect(leftPanelText).toContain('Кастомні поля');
    expect(leftPanelText).toContain('inventory_id');
    expect(leftPanelText).toContain('node-1');
    expect(leftPanelText).not.toContain('Теги');
    expect(container?.textContent).not.toContain('Архівувати');
    expect(container?.textContent).not.toContain('Відновити');
    expect(container?.querySelector('[aria-label="Активний"]')).not.toBeNull();
    expect(container?.querySelector('button[aria-label="Редагувати пристрій"]')).not.toBeNull();
    expect(deviceNameLink?.getAttribute('href')).toBe(activeDevice.externalUrl);
    expect(deviceNameLink?.getAttribute('target')).toBe('_blank');
    expect(deviceNameLink?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(deviceNameLink?.querySelector('[data-testid="OpenInNewIcon"]')).not.toBeNull();
    expect(leftPanelText.indexOf('Основне')).toBeLessThan(leftPanelText.indexOf('Кастомні поля'));
    expect(leftPanelText.indexOf('Кастомні поля')).toBeLessThan(leftPanelText.indexOf('Додатково'));
    const tabs = Array.from(container?.querySelectorAll('[role="tab"]') ?? []);
    expect(tabs).toHaveLength(3);
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Аналітичні відомості', 'Файли', 'Журнал']);
    expect(
      container
        ?.querySelector('[data-testid="device-analytics-panel"]')
        ?.getAttribute('data-is-admin'),
    ).toBe('false');
    expect(pageMock.useDeviceAnalyticsTags).toHaveBeenLastCalledWith({
      deviceId: DEVICE_ID,
      enabled: true,
    });
    expect(container?.querySelector('[data-testid="device-files-sidebar"]')).toBeNull();
    expect(container?.querySelector('[data-testid="device-file-content-pane"]')).toBeNull();
    expect(container?.querySelector('button[aria-label="Згорнути ліву панель"]')).not.toBeNull();

    const journalTab = tabs.find((tab) => tab.textContent === 'Журнал');
    act(() => journalTab?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container?.querySelector('[data-testid="device-details-left-panel"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="device-file-journal"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="device-files-sidebar"]')).toBeNull();
    expect(pageMock.useDeviceFileJournal).toHaveBeenLastCalledWith({
      deviceId: DEVICE_ID,
      enabled: true,
      tagFilter: { tagIds: [], tagMatch: 'any', untagged: false },
    });

    const filesTab = tabs.find((tab) => tab.textContent === 'Файли');
    act(() => filesTab?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container?.querySelector('[data-testid="device-details-left-panel"]')).toBeNull();
    const filesSidebar = container?.querySelector('[data-testid="device-files-sidebar"]');
    expect(filesSidebar).not.toBeNull();
    expect(filesSidebar?.closest('[hidden]')).toBeNull();
    expect(container?.querySelector('[data-testid="device-file-content-pane"]')).not.toBeNull();

    const collapseButton = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Згорнути ліву панель"]',
    );
    act(() => collapseButton?.click());
    expect(container?.querySelector('[data-testid="device-files-sidebar"]')).not.toBeNull();
    expect(filesSidebar?.closest('[hidden]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="device-file-content-pane"]')).not.toBeNull();
    expect(container?.querySelector('button[aria-label="Розгорнути ліву панель"]')).not.toBeNull();
  });

  it('exposes the device reanalysis action only to Admin', () => {
    renderPage(['Admin']);

    expect(
      container
        ?.querySelector('[data-testid="device-analytics-panel"]')
        ?.getAttribute('data-is-admin'),
    ).toBe('true');
  });

  it('keeps the device name non-clickable when the external URL is unsafe', () => {
    pageMock.useDeviceDetailsPage.mockReturnValue(
      buildPage({
        device: {
          ...activeDevice,
          externalUrl: 'javascript:alert(document.domain)',
        },
      }),
    );

    renderPage();

    const leftPanel = container?.querySelector('[data-testid="device-details-left-panel"]');
    const deviceNameLink = Array.from(leftPanel?.querySelectorAll('a') ?? []).find(
      (element) => element.textContent === activeDevice.name,
    );
    expect(leftPanel?.textContent).toContain(activeDevice.name);
    expect(leftPanel?.textContent).not.toContain('javascript:');
    expect(deviceNameLink).toBeUndefined();
    expect(leftPanel?.querySelector('[data-testid="OpenInNewIcon"]')).toBeNull();
  });

  it('keeps archived devices read-only', () => {
    pageMock.useDeviceDetailsPage.mockReturnValue(
      buildPage({
        device: {
          ...activeDevice,
          archived: true,
          archivedAt: '2026-01-03T00:00:00Z',
        },
      }),
    );

    renderPage();

    expect(container?.textContent).toContain('Пристрій архівовано. Редагування недоступне.');
    expect(container?.querySelector('button[aria-label="Редагувати пристрій"]')).toBeNull();
    expect(container?.textContent).not.toContain('Відновити');
    expect(container?.querySelector('[aria-label="Архівний"]')).not.toBeNull();
    const filesTab = Array.from(container?.querySelectorAll('[role="tab"]') ?? []).find(
      (tab) => tab.textContent === 'Файли',
    );
    act(() => filesTab?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const filesSidebar = container?.querySelector('[data-testid="device-files-sidebar"]');
    expect(filesSidebar).not.toBeNull();
    expect(container?.querySelector('[data-testid="device-file-content-pane"]')).not.toBeNull();
  });
});
