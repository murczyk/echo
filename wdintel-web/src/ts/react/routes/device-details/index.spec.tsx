/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceDetails } from '../../../../Bindings';
import { DeviceDetailsPage } from './index';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';

const pageMock = vi.hoisted(() => ({
  useDeviceDetailsPage: vi.fn(),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

vi.mock('./use-device-details-page', () => ({
  useDeviceDetailsPage: pageMock.useDeviceDetailsPage,
}));

const activeDevice: DeviceDetails = {
  id: DEVICE_ID,
  sourceLabel: 'Inventory import',
  name: 'Device Alpha',
  createdBy: 'operator',
  aorIds: [1, 2],
  aorNames: ['Північ', 'Південь'],
  unitId: 7,
  unitName: 'Unit Seven',
  tags: [{ label: 'IP', value: '10.0.0.1' }],
  externalUrl: 'https://example.test/device-alpha',
  customFields: { inventory_id: 'node-1' },
  archived: false,
  createdAtMs: 1_700_000_000_000,
  updatedAtMs: 1_700_000_010_000,
  archivedAtMs: null,
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

beforeEach(() => {
  pageMock.useDeviceDetailsPage.mockReturnValue(buildPage());
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

function openDeviceActionsMenu() {
  const menuButton = container?.querySelector('button[aria-label="Дії з пристроєм"]');
  if (!(menuButton instanceof HTMLElement)) throw new Error('device actions menu button not found');
  act(() => {
    menuButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

function actionMenuLabels() {
  return Array.from(document.querySelectorAll('[role="menuitem"]')).map((element) =>
    element.textContent?.trim(),
  );
}

describe('DeviceDetailsPage layout', () => {
  it('renders device metadata without file UI', () => {
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
    expect(leftPanelText).toContain('Джерельна мітка');
    expect(leftPanelText).toContain('Inventory import');
    expect(leftPanelText).toContain('Кастомні поля');
    expect(leftPanelText).toContain('inventory_id');
    expect(leftPanelText).toContain('node-1');
    expect(leftPanelText).not.toContain('Хостнейм');
    expect(leftPanelText).not.toContain('SSH-порт');
    expect(container?.textContent).not.toContain('Зовнішнє посилання');
    expect(container?.textContent).not.toContain('Оновити');
    expect(container?.textContent).not.toContain('Редагувати');
    expect(container?.textContent).not.toContain('Архівувати');
    expect(container?.querySelector('[aria-label="Активний"]')).not.toBeNull();
    expect(container?.querySelector('button[aria-label="Дії з пристроєм"]')).not.toBeNull();
    expect(deviceNameLink?.getAttribute('href')).toBe(activeDevice.externalUrl);
    expect(deviceNameLink?.getAttribute('target')).toBe('_blank');
    expect((leftPanelText ?? '').indexOf('Основне')).toBeLessThan(
      (leftPanelText ?? '').indexOf('Теги'),
    );
    expect((leftPanelText ?? '').indexOf('Теги')).toBeLessThan(
      (leftPanelText ?? '').indexOf('Кастомні поля'),
    );
    expect((leftPanelText ?? '').indexOf('Кастомні поля')).toBeLessThan(
      (leftPanelText ?? '').indexOf('Додатково'),
    );
    expect(container?.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(container?.textContent).not.toContain('Файли');
    expect(container?.textContent).not.toContain('Метадані файлів');

    openDeviceActionsMenu();
    expect(actionMenuLabels()).toEqual(['Редагувати', 'Архівувати']);
  });

  it('keeps archived devices restore-only without file UI', () => {
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

    expect(container?.textContent).toContain('Пристрій архівовано');
    expect(container?.textContent).not.toContain('Редагувати');
    expect(container?.textContent).not.toContain('Відновити');
    expect(container?.querySelector('[aria-label="Архівний"]')).not.toBeNull();

    openDeviceActionsMenu();
    expect(actionMenuLabels()).toEqual(['Відновити']);
  });
});
