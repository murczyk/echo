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

vi.mock('../device-files', () => ({
  DeviceFilesPanel: ({ canSync }: { canSync: boolean }) => (
    <div data-testid="device-files-panel" data-can-sync={String(canSync)}>
      Файли
    </div>
  ),
}));

const activeDevice: DeviceDetails = {
  id: DEVICE_ID,
  sourceLabel: 'Inventory import',
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
      canSyncFiles: true,
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
    root?.render(<DeviceDetailsPage deviceId={DEVICE_ID} authUserRoles={['DeviceAnalyst']} />);
  });
}

describe('DeviceDetailsPage layout', () => {
  it('renders target device metadata and only the supported edit action', () => {
    renderPage();

    const leftPanel = container?.querySelector('[data-testid="device-details-left-panel"]');
    const leftPanelText = leftPanel?.textContent ?? '';
    const externalLink = Array.from(leftPanel?.querySelectorAll('a') ?? []).find(
      (element) => element.textContent === activeDevice.externalUrl,
    );

    expect(leftPanelText).toContain('Device Alpha');
    expect(leftPanelText).toContain(DEVICE_ID);
    expect(leftPanelText).toContain('Активний');
    expect(leftPanelText).toContain('Північ');
    expect(leftPanelText).toContain('Південь');
    expect(leftPanelText).toContain('Unit Seven');
    expect(leftPanelText).toContain('operator');
    expect(leftPanelText).toContain('Джерельна мітка');
    expect(leftPanelText).toContain('Inventory import');
    expect(leftPanelText).toContain('Зовнішнє посилання');
    expect(leftPanelText).toContain('Кастомні поля');
    expect(leftPanelText).toContain('inventory_id');
    expect(leftPanelText).toContain('node-1');
    expect(leftPanelText).not.toContain('Теги');
    expect(container?.textContent).not.toContain('Архівувати');
    expect(container?.textContent).not.toContain('Відновити');
    expect(container?.querySelector('[aria-label="Активний"]')).not.toBeNull();
    expect(container?.querySelector('button[aria-label="Редагувати пристрій"]')).not.toBeNull();
    expect(externalLink?.getAttribute('href')).toBe(activeDevice.externalUrl);
    expect(externalLink?.getAttribute('target')).toBe('_blank');
    expect(leftPanelText.indexOf('Основне')).toBeLessThan(leftPanelText.indexOf('Кастомні поля'));
    expect(leftPanelText.indexOf('Кастомні поля')).toBeLessThan(leftPanelText.indexOf('Додатково'));
    expect(container?.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(container?.querySelector('[data-testid="device-files-panel"]')).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="device-files-panel"]')?.getAttribute('data-can-sync'),
    ).toBe('true');
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
    expect(
      container?.querySelector('[data-testid="device-files-panel"]')?.getAttribute('data-can-sync'),
    ).toBe('false');
  });
});
