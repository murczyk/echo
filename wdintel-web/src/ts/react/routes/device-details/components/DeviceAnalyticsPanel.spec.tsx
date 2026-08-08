/** @vitest-environment happy-dom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceAnalyticsPanel } from './DeviceAnalyticsPanel';

const mocks = vi.hoisted(() => ({
  getDeviceAnalyticsSummary: vi.fn(),
  listDeviceAnalyticsFiles: vi.fn(),
  reanalyzeDevice: vi.fn(),
  redirectToLogin: vi.fn(),
}));

vi.mock('../../../services/api/devices', () => ({
  getDeviceAnalyticsSummary: mocks.getDeviceAnalyticsSummary,
  listDeviceAnalyticsFiles: mocks.listDeviceAnalyticsFiles,
  reanalyzeDevice: mocks.reanalyzeDevice,
}));

vi.mock('../../../auth-redirect', () => ({ redirectToLogin: mocks.redirectToLogin }));

vi.mock('../../device-files/components/DeviceAnalyticsTagFilterControls', () => ({
  DeviceAnalyticsTagFilterControls: () => <div>Фільтри тегів</div>,
}));

const tagsState = {
  tags: [
    { id: 'tag-1', name: 'Звіти' },
    { id: 'tag-2', name: 'Архіви' },
  ],
  loading: false,
  error: null,
  reload: vi.fn(),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(window, 'confirm', {
    configurable: true,
    value: vi.fn(() => true),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function renderPanel(
  onTagFilterChange = vi.fn(),
  options: { isAdmin?: boolean; children?: ReactNode } = {},
) {
  act(() => {
    root.render(
      <DeviceAnalyticsPanel
        deviceId="device-1"
        enabled
        isAdmin={options.isAdmin ?? false}
        tagsState={tagsState}
        tagFilter={{ tagIds: [], tagMatch: 'any', untagged: false }}
        onTagFilterChange={onTagFilterChange}
      />,
    );
  });
}

function buttonContaining(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
  return button;
}

describe('DeviceAnalyticsPanel', () => {
  it('renders every active tag and lazily paginates a generic tag widget', async () => {
    mocks.getDeviceAnalyticsSummary.mockResolvedValue({
      totalFileCount: 18,
      analyzedFileCount: 12,
      items: [
        {
          tag: { id: 'tag-1', name: 'Звіти' },
          fileCount: 5,
          latestFileEntryCreatedAt: '2026-08-06T12:00:00Z',
        },
      ],
    });
    mocks.listDeviceAnalyticsFiles
      .mockResolvedValueOnce({
        files: [
          {
            fileId: 'file-1',
            name: 'report.pdf',
            absolutePath: 'C:\\reports\\report.pdf',
            fileEntryCreatedAt: '2026-08-06T12:00:00Z',
          },
        ],
        nextCursor: 'cursor-1',
      })
      .mockResolvedValueOnce({
        files: [
          {
            fileId: 'file-2',
            name: 'report-2.pdf',
            absolutePath: 'C:\\reports\\report-2.pdf',
            fileEntryCreatedAt: '2026-08-06T11:00:00Z',
          },
        ],
        nextCursor: null,
      });
    const onTagFilterChange = vi.fn();

    renderPanel(onTagFilterChange);
    await flush();

    expect(container.textContent).toContain('Усього файлів18');
    expect(container.textContent).toContain('Проаналізовано файлів12');
    expect(container.textContent).toContain('Звіти');
    expect(container.textContent).toContain('Архіви');
    expect(container.textContent).toContain('5 файлів');
    expect(container.textContent).toContain('0 файлів');

    act(() => buttonContaining('Звіти').click());
    await flush();
    expect(mocks.listDeviceAnalyticsFiles).toHaveBeenCalledWith(
      { deviceId: 'device-1', tagId: 'tag-1', limit: 10, cursor: null },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.textContent).toContain('report.pdf');

    act(() => buttonContaining('Використати як фільтр').click());
    expect(onTagFilterChange).toHaveBeenCalledWith({
      tagIds: ['tag-1'],
      tagMatch: 'any',
      untagged: false,
    });

    act(() => buttonContaining('Завантажити ще').click());
    await flush();
    expect(mocks.listDeviceAnalyticsFiles).toHaveBeenLastCalledWith(
      { deviceId: 'device-1', tagId: 'tag-1', limit: 10, cursor: 'cursor-1' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(container.textContent).toContain('report-2.pdf');
  });

  it('keeps a failed widget retryable and exposes device reanalysis only to Admin', async () => {
    mocks.getDeviceAnalyticsSummary.mockResolvedValue({
      totalFileCount: 0,
      analyzedFileCount: 0,
      items: [],
    });
    mocks.listDeviceAnalyticsFiles
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ files: [], nextCursor: null });
    mocks.reanalyzeDevice.mockResolvedValue({ scheduledFileCount: 42 });

    renderPanel(vi.fn(), { isAdmin: true });
    await flush();
    act(() => buttonContaining('Звіти').click());
    await flush();
    expect(container.textContent).toContain('Помилка завантаження файлів тегу «Звіти»');

    act(() => buttonContaining('Повторити').click());
    await flush();
    expect(mocks.listDeviceAnalyticsFiles).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Файлів із цим тегом немає.');

    act(() => buttonContaining('Запустити повторний аналіз пристрою').click());
    await flush();
    expect(mocks.reanalyzeDevice).toHaveBeenCalledWith({ deviceId: 'device-1' });
    expect(container.textContent).toContain('Заплановано повторний аналіз 42 файлів.');
  });
});
