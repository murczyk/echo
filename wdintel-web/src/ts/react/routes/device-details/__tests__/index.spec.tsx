/**
 * @vitest-environment happy-dom
 */
import { ThemeProvider } from '@mui/material/styles';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceDetails, DeviceAudioDetails } from '../../../../../Bindings';
import { createNeoMuiTheme } from '../../../mui-theme';
import { DeviceDetailsPage } from '.././index';
import { DeviceDetailsSection } from '../page-route';
import {
  listDeviceAudio,
  getDeviceAudioDetail,
  getDeviceAudioSettings,
  getDeviceAudioTranscriptionStatus,
  prepareDeviceAudio,
} from '../../../services/api/device-audio';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const testTheme = createNeoMuiTheme('light');

const pageMock = vi.hoisted(() => ({
  useDeviceDetailsPage: vi.fn(),
  useDeviceFiles: vi.fn(),
  useDeviceFileJournal: vi.fn(),
  useDeviceAnalyticsTags: vi.fn(),
  useDeviceSyncSessions: vi.fn(),
}));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

vi.mock('../../../services/api/device-audio', () => ({
  listDeviceAudio: vi.fn(),
  getDeviceAudioDetail: vi.fn(),
  getDeviceAudioSettings: vi.fn(),
  getDeviceAudioTranscriptionStatus: vi.fn(),
  prepareDeviceAudio: vi.fn(),
}));
vi.mock('../../../services/api/author-identities', () => ({
  fetchAuthorIdentities: async () => ({ authors: [] }),
}));
vi.mock('../use-device-sync-sessions', () => ({
  useDeviceSyncSessions: pageMock.useDeviceSyncSessions,
}));

vi.mock('.././use-device-details-page', () => ({
  useDeviceDetailsPage: pageMock.useDeviceDetailsPage,
}));

vi.mock('../../device-files/use-device-file-journal', () => ({
  useDeviceFileJournal: pageMock.useDeviceFileJournal,
}));

vi.mock('../../device-files/use-device-analytics-tags', () => ({
  useDeviceAnalyticsTags: pageMock.useDeviceAnalyticsTags,
}));

vi.mock('../../device-files', () => ({
  useDeviceFiles: pageMock.useDeviceFiles,
  DeviceFilesSidebar: () => <aside data-testid="device-files-sidebar">Бічна панель файлів</aside>,
  DeviceFileContentPane: () => (
    <section data-testid="device-file-content-pane">Вміст файлу</section>
  ),
}));

vi.mock('../../device-files/components/DeviceFileJournal', () => ({
  DeviceFileJournal: () => <div data-testid="device-file-journal">Журнал синхронізації</div>,
}));

vi.mock('.././components/DeviceAnalyticsPanel', () => ({
  DeviceAnalyticsPanel: ({ isAdmin }: { isAdmin: boolean }) => (
    <div data-testid="device-analytics-panel" data-is-admin={String(isAdmin)}>
      Аналітика файлів
    </div>
  ),
}));

const activeDevice: DeviceDetails = {
  rating: 0,
  tags: [],
  description: null,
  audioForwardingConfigured: false,
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
  vi.mocked(listDeviceAudio).mockResolvedValue({ audio: [], nextCursor: null });
  pageMock.useDeviceSyncSessions.mockReturnValue({
    ready: true,
    session: null,
    selectionError: null,
    refreshVersion: 0,
    refresh: vi.fn(),
  });
  pageMock.useDeviceDetailsPage.mockReturnValue(buildPage());
  pageMock.useDeviceFiles.mockReturnValue({ counts: { error: null }, tree: { branches: {} } });
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
    loaded: true,
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

function renderPage(authUserRoles: string[] = ['Cyber'], section = DeviceDetailsSection.Overview) {
  act(() => {
    root?.render(
      <ThemeProvider theme={testTheme}>
        <DeviceDetailsPage deviceId={DEVICE_ID} authUserRoles={authUserRoles} section={section} />
      </ThemeProvider>,
    );
  });
}

describe('DeviceDetailsPage layout', () => {
  it('renders target device metadata and only the supported edit action', () => {
    renderPage();

    const leftPanel = container?.querySelector('[data-testid="device-details-overview"]');
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
    const links = Array.from(
      container?.querySelectorAll('nav[aria-label="Меню пристрою"] a') ?? [],
    );
    expect(container?.querySelector('[role="tab"]')).toBeNull();
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `/devices/${DEVICE_ID}/files`,
      `/devices/${DEVICE_ID}/journal`,
      `/devices/${DEVICE_ID}/audio`,
    ]);
    expect(links.map((link) => link.textContent)).toEqual(['Файли', 'Журнал', 'Аудіо']);
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

    renderPage(['Cyber'], DeviceDetailsSection.Journal);

    expect(container?.querySelector('[data-testid="device-details-navigation"]')).toBeNull();
    expect(container?.querySelector('button[aria-label="До пристрою"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="device-file-journal"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="device-files-sidebar"]')).toBeNull();
    expect(pageMock.useDeviceFileJournal).toHaveBeenLastCalledWith({
      deviceId: DEVICE_ID,
      syncId: null,
      enabled: true,
      tagFilter: { tagIds: [], tagMatch: 'any', untagged: false },
    });

    renderPage(['Cyber'], DeviceDetailsSection.Files);
    expect(container?.querySelector('[data-testid="device-details-navigation"]')).toBeNull();

    expect(container?.querySelector('[data-testid="device-details-overview"]')).toBeNull();
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

    const leftPanel = container?.querySelector('[data-testid="device-details-overview"]');
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
    renderPage(['Cyber'], DeviceDetailsSection.Files);
    const filesSidebar = container?.querySelector('[data-testid="device-files-sidebar"]');
    expect(filesSidebar).not.toBeNull();
    expect(container?.querySelector('[data-testid="device-file-content-pane"]')).not.toBeNull();
  });
});

it('keeps_audio_usable_when_file_sessions_fail', async () => {
  pageMock.useDeviceSyncSessions.mockReturnValue({
    ready: false,
    session: null,
    selectionError: 'Сесія недоступна',
    refreshVersion: 0,
    refresh: vi.fn(),
  });
  await act(async () => renderPage(['Cyber'], DeviceDetailsSection.Audio));
  expect(container!.querySelector('[role="region"][aria-label="Аудіо"]')).not.toBeNull();
  expect(container!.querySelector('[data-testid="device-details-navigation"]')).toBeNull();
  expect(container!.textContent).toContain('Аудіоматеріалів немає.');
  expect(container!.textContent).not.toContain('Сесія недоступна');
  expect(vi.mocked(listDeviceAudio)).toHaveBeenCalledWith(
    { deviceId: DEVICE_ID, unprocessedOnly: false, limit: 50, cursor: null },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it('#3645 reopens the same mobile audio with manual text after returning from the automatic original', async () => {
  const media = vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('width'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
  const detail: DeviceAudioDetails = {
    audio: {
      id: 'audio-one',
      deviceId: DEVICE_ID,
      name: 'recording.wav',
      recordingStartedAt: '2026-10-03T00:00:00Z',
      recordingEndedAt: '2026-10-03T00:00:01Z',
      durationSeconds: 1,
      processed: false,
      processingVersion: 'p1',
    },
    transcription: { text: 'manual text', textVersion: 'v1' },
    automaticTranscription: {
      version: 'a1',
      text: 'automatic original',
      state: 'succeeded',
      retryAt: null,
      message: null,
    },
    transcriptionAvailability: {
      deviceEnabled: true,
      globalEnabled: true,
      canEditManual: true,
      canManageSetting: true,
      canRetry: false,
      blockedReason: null,
    },
    canEdit: true,
  };
  vi.mocked(listDeviceAudio).mockResolvedValue({ audio: [detail.audio], nextCursor: null });
  vi.mocked(getDeviceAudioDetail).mockResolvedValue(detail);
  vi.mocked(getDeviceAudioSettings).mockResolvedValue({
    deviceId: DEVICE_ID,
    enabled: true,
    globalEnabled: true,
    canManageSetting: true,
    blockedReason: null,
  });
  vi.mocked(getDeviceAudioTranscriptionStatus).mockResolvedValue({
    audioId: detail.audio.id,
    snapshot: detail.automaticTranscription,
    availability: detail.transcriptionAvailability,
  });
  vi.mocked(prepareDeviceAudio).mockResolvedValue({
    audioId: detail.audio.id,
    content: 'queued',
    wave: 'queued',
    spectrogram: 'queued',
    retryAfterMs: 1000,
    transcriptionAdmissionError: null,
  });
  const button = (label: string) =>
    Array.from(container!.querySelectorAll<HTMLButtonElement>('button')).find(
      (element) => element.textContent === label,
    )!;
  const row = () => container!.querySelector<HTMLButtonElement>('[data-audio-id="audio-one"]')!;
  try {
    await act(async () => renderPage(['Cyber'], DeviceDetailsSection.Audio));
    await act(async () => row().click());
    await act(async () => button('Автоматична').click());
    expect(container!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe(
      'automatic original',
    );
    await act(async () => button('До аудіо').click());
    expect(container!.querySelector('[data-device-audio-editor]')).toBeNull();
    await act(async () => new Promise((done) => setTimeout(done, 410)));
    await act(async () => row().click());
    expect(container!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('manual text');
    expect(button('Ручна').getAttribute('aria-pressed')).toBe('true');
    await act(async () => button('Автоматична').click());
    await act(async () => renderPage());
    await act(async () => renderPage(['Cyber'], DeviceDetailsSection.Audio));
    expect(container!.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('manual text');
  } finally {
    media.mockRestore();
  }
});
