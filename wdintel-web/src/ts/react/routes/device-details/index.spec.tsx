/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceDetails, DeviceFileEntry } from '../../../../Bindings';
import { DeviceDetailsPage } from './index';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';

const pageMock = vi.hoisted(() => ({
  useDeviceDetailsPage: vi.fn(),
}));

const filesMock = vi.hoisted(() => ({
  useDeviceFiles: vi.fn(),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

vi.mock('@mui/material', async () => {
  const actual = await vi.importActual<typeof import('@mui/material')>('@mui/material');
  return {
    ...actual,
    useMediaQuery: () => true,
  };
});

vi.mock('./use-device-details-page', () => ({
  useDeviceDetailsPage: pageMock.useDeviceDetailsPage,
}));

vi.mock('./use-device-files', () => ({
  useDeviceFiles: filesMock.useDeviceFiles,
}));

const activeDevice: DeviceDetails = {
  id: DEVICE_ID,
  name: 'Device Alpha',
  createdBy: 'operator',
  aorIds: [1, 2],
  aorNames: ['Північ', 'Південь'],
  unitId: 7,
  unitName: 'Unit Seven',
  tags: [{ label: 'IP', value: '10.0.0.1' }],
  externalUrl: 'https://example.test/device-alpha',
  archived: false,
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_010_000,
  archivedAtMs: null,
};

const fileEntry: DeviceFileEntry = {
  fileId: 'file-1',
  deviceId: DEVICE_ID,
  originalName: 'manual.pdf',
  originalAbsolutePath: '/tmp/manual.pdf',
  originalCreatedAtMs: null,
  originalModifiedAtMs: null,
  deleted: false,
  createdAtMs: 1_700_000_020_000,
  updatedAtMs: 1_700_000_030_000,
  deletedAtMs: null,
};

function buildPage(overrides: Record<string, unknown> = {}) {
  return {
    permissions: { canRead: true, canEdit: true },
    device: activeDevice,
    loading: false,
    refreshing: false,
    status: null,
    mutating: false,
    aorOptions: [],
    unitOptions: [],
    lookupsLoading: false,
    editForm: null,
    editError: null,
    editServerFieldErrors: {},
    editSubmitting: false,
    editHasChanges: false,
    archiveDialogOpen: false,
    initialLoadFailed: false,
    reload: vi.fn(),
    openEditDrawer: vi.fn(),
    closeEditDrawer: vi.fn(),
    setEditForm: vi.fn(),
    saveEditDevice: vi.fn(),
    openArchiveDialog: vi.fn(),
    closeArchiveDialog: vi.fn(),
    confirmArchiveCurrentDevice: vi.fn(),
    restoreCurrentDevice: vi.fn(),
    ...overrides,
  };
}

function buildFiles(overrides: Record<string, unknown> = {}) {
  return {
    files: [fileEntry],
    deletedFilter: 'active',
    total: 1,
    hasMore: false,
    loading: false,
    refreshing: false,
    loadingMore: false,
    status: null,
    mutatingFileId: null,
    createDialogOpen: false,
    createRows: [],
    createError: null,
    createServerFieldErrors: {},
    creatingFiles: false,
    deleteDialogFile: null,
    hasFilters: false,
    initialLoadFailed: false,
    setDeletedFilter: vi.fn(),
    reload: vi.fn(),
    loadMore: vi.fn(),
    openCreateDialog: vi.fn(),
    closeCreateDialog: vi.fn(),
    setCreateRows: vi.fn(),
    submitCreateFiles: vi.fn(),
    deleteFile: vi.fn(),
    closeDeleteDialog: vi.fn(),
    confirmDeleteFile: vi.fn(),
    restoreFile: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  pageMock.useDeviceDetailsPage.mockReturnValue(buildPage());
  filesMock.useDeviceFiles.mockReturnValue(buildFiles());
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

function renderPage() {
  act(() => {
    root?.render(<DeviceDetailsPage deviceId={DEVICE_ID} authUserRoles={['DevicesEditor']} />);
  });
}

function clickTab(label: string) {
  const tab = Array.from(container?.querySelectorAll('[role="tab"]') ?? []).find(
    (element) => element.textContent === label,
  );
  if (!(tab instanceof HTMLElement)) throw new Error(`tab not found: ${label}`);
  act(() => {
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('DeviceDetailsPage layout', () => {
  it('renders main information in the left panel and exactly two main tabs', () => {
    renderPage();

    const leftPanel = container?.querySelector('[data-testid="device-details-left-panel"]');
    const leftPanelText = leftPanel?.textContent;
    const deviceNameLink = Array.from(leftPanel?.querySelectorAll('a') ?? []).find(
      (element) => element.textContent === 'Device Alpha',
    );

    expect(leftPanelText).toContain('Device Alpha');
    expect(leftPanelText).toContain('Активний');
    expect(leftPanelText).toContain('Північ');
    expect(leftPanelText).toContain('Південь');
    expect(leftPanelText).toContain('Unit Seven');
    expect(leftPanelText).toContain('operator');
    expect(leftPanelText).toContain('Теги');
    expect(leftPanelText).toContain('IP');
    expect(leftPanelText).toContain('10.0.0.1');
    expect(container?.textContent).not.toContain('Зовнішнє посилання');
    expect(container?.textContent).not.toContain('Оновити');
    expect(deviceNameLink?.getAttribute('href')).toBe(activeDevice.externalUrl);
    expect(deviceNameLink?.getAttribute('target')).toBe('_blank');
    expect((leftPanelText ?? '').indexOf('Додатково')).toBeLessThan(
      (leftPanelText ?? '').indexOf('Теги'),
    );

    const tabs = Array.from(container?.querySelectorAll('[role="tab"]') ?? []).map((element) =>
      element.textContent?.trim(),
    );
    expect(tabs).toEqual(['Опис', 'Файли']);
    expect(container?.textContent).not.toContain('Реєстрові поля');
    expect(
      container
        ?.querySelector('[data-testid="device-details-description-tab"]')
        ?.textContent?.trim(),
    ).toBe('');
    expect(container?.textContent).not.toContain('Метадані файлів');

    clickTab('Файли');

    expect(container?.textContent).toContain('Метадані файлів · знайдено: 1');
    expect(container?.textContent).toContain('manual.pdf');
  });

  it('keeps archived devices restore-only and blocks file mutations in the files tab', () => {
    pageMock.useDeviceDetailsPage.mockReturnValue(
      buildPage({
        device: {
          ...activeDevice,
          archived: true,
          archivedAtMs: 1_700_000_040_000,
        },
      }),
    );

    renderPage();

    expect(filesMock.useDeviceFiles).toHaveBeenCalledWith(
      expect.objectContaining({ parentArchived: true }),
    );
    expect(container?.textContent).toContain('Пристрій архівовано');
    expect(container?.textContent).not.toContain('Редагувати');
    expect(container?.textContent).toContain('Відновити');

    clickTab('Файли');

    expect(container?.textContent).toContain(
      'Відновіть пристрій перед додаванням, видаленням або відновленням файлів.',
    );
  });
});
