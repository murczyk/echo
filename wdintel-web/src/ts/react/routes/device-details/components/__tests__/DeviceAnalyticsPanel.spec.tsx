/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeviceAnalyticsPanel } from '.././DeviceAnalyticsPanel';

const mocks = vi.hoisted(() => ({
  getDeviceAnalyticsSummary: vi.fn(),
  reanalyzeDevice: vi.fn(),
  redirectToLogin: vi.fn(),
  getDeviceAudioActivity: vi.fn(),
}));

vi.mock('../../../../services/api/devices', () => ({
  getDeviceAnalyticsSummary: mocks.getDeviceAnalyticsSummary,
  reanalyzeDevice: mocks.reanalyzeDevice,
}));

vi.mock('../../../../services/api/device-audio', () => ({
  getDeviceAudioActivity: mocks.getDeviceAudioActivity,
}));

vi.mock('../../../../auth-redirect', () => ({ redirectToLogin: mocks.redirectToLogin }));

const tagsState = {
  loaded: true,
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
  mocks.getDeviceAudioActivity.mockResolvedValue({
    uploadedCount: 3,
    days: [{ day: '2026-11-02', contentCount: 3, contentBytes: 3000 }],
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
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

function renderPanel(options: { isAdmin?: boolean } = {}) {
  act(() => {
    root.render(
      <DeviceAnalyticsPanel
        deviceId="device-1"
        enabled
        isAdmin={options.isAdmin ?? false}
        tagsState={tagsState}
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

function bodyButtonContaining(text: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find((item) =>
    item.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`);
  return button;
}
describe('DeviceAnalyticsPanel', () => {
  it('renders only active tags with files and preserves file counters', async () => {
    mocks.getDeviceAnalyticsSummary.mockResolvedValue({
      totalFileCount: 18,
      filesWithContentCount: 7,
      analyzedFileCount: 12,
      items: [
        {
          tag: { id: 'tag-1', name: 'Звіти' },
          fileCount: 5,
          latestFileEntryCreatedAt: '2026-08-06T12:00:00Z',
        },
      ],
    });
    renderPanel();
    await flush();

    expect(container.textContent).toContain('Файлів з контентом / усього7/18');
    expect(container.textContent).toContain('Завантажено аудіо3');
    expect(container.textContent).toContain('Звіти');
    expect(container.textContent).not.toContain('Архіви');
    expect(container.textContent).toContain('5 файлів');
    expect(container.textContent).not.toContain('0 файлів');
  });

  it('shows an empty state when active tags have no files', async () => {
    mocks.getDeviceAnalyticsSummary.mockResolvedValue({
      totalFileCount: 4,
      filesWithContentCount: 0,
      analyzedFileCount: 4,
      items: [
        {
          tag: { id: 'tag-1', name: 'Звіти' },
          fileCount: 0,
          latestFileEntryCreatedAt: null,
        },
      ],
    });

    renderPanel();
    await flush();

    expect(container.textContent).toContain('Файлів з активними аналітичними тегами ще немає.');
    expect(container.textContent).not.toContain('0 файлів');
  });

  it('keeps failed analytics retryable and confirms device reanalysis for Admin', async () => {
    mocks.getDeviceAnalyticsSummary.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      totalFileCount: 1,
      filesWithContentCount: 1,
      analyzedFileCount: 1,
      items: [
        {
          tag: { id: 'tag-1', name: 'Звіти' },
          fileCount: 1,
          latestFileEntryCreatedAt: '2026-08-06T12:00:00Z',
        },
      ],
    });
    mocks.reanalyzeDevice.mockResolvedValue({ run: { runId: 'run-1' } });

    renderPanel({ isAdmin: true });
    await flush();
    expect(container.textContent).toContain('Помилка завантаження аналітичних відомостей');

    act(() => buttonContaining('Повторити').click());
    await flush();
    expect(container.textContent).not.toContain('Помилка завантаження аналітичних відомостей');
    expect(container.textContent).toContain('Звіти');

    act(() => buttonContaining('Запустити повторний аналіз пристрою').click());
    await flush();
    expect(mocks.reanalyzeDevice).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Запустити повторний аналіз пристрою?');

    act(() => bodyButtonContaining('Запустити аналіз').click());
    await flush();
    expect(mocks.reanalyzeDevice).toHaveBeenCalledWith({ deviceId: 'device-1' });
    expect(container.textContent).toContain('Повторний аналіз запущено у фоновому режимі.');
  });
});
