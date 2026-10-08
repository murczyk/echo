// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminDocumentsPage } from '..';

const settings = {
  enabled: true,
  summariesEnabled: false,
  positionsEnabled: false,
  aiEngineId: null,
  positionEngineId: null,
};

const mocks = vi.hoisted(() => ({
  messages: vi.fn(),
  devices: vi.fn(),
}));

vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: vi.fn() }),
}));
vi.mock('../../../services/api/attachments', () => ({
  getAttachmentsPage: mocks.messages,
  retryAttachment: vi.fn(),
  saveAttachmentSettings: vi.fn(),
}));
vi.mock('../../../services/api/device-documents', () => ({
  getDeviceDocumentsPage: mocks.devices,
  retryDeviceDocument: vi.fn(),
  saveDeviceDocumentSettings: vi.fn(),
}));
vi.mock('../../shared/message-card/attachment-preview/DocumentContentDialog', () => ({
  AttachmentDocumentDialog: () => null,
}));

let root: ReturnType<typeof createRoot> | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

function attachment(index: number) {
  return {
    mediaId: `m${index}`,
    messageId: index,
    messageUuid: null,
    fileName: `file-${index}.pdf`,
    contentType: 'application/pdf',
    state: 'done',
    quality: null,
    complete: true,
    revision: null,
    summary: null,
    summaryState: 'done',
    positionState: 'done',
    chunkCount: 1,
    lastError: null,
    snippet: null,
    citation: '',
  };
}

function attachmentsPage(from: number, count: number) {
  return {
    settings: { ...settings, backfillComplete: true },
    counts: [],
    engines: [],
    documents: Array.from({ length: count }, (_, index) => attachment(from + index)),
  };
}

async function mount() {
  mocks.devices.mockResolvedValue({
    available: false,
    settings,
    backfillComplete: false,
    discovered: 0,
    counts: [],
    documents: [],
    engines: [],
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<AdminDocumentsPage />));
  await act(async () => {});
  return container;
}

function loadMoreButton(container: HTMLElement) {
  return Array.from(container.querySelectorAll('button')).find((button) =>
    button.textContent?.includes('Наступні документи'),
  );
}

describe('AdminDocumentsPage pagination', () => {
  it('appends the next page once with the submitted query and hides load-more when exhausted', async () => {
    mocks.messages
      .mockResolvedValueOnce(attachmentsPage(0, 50))
      .mockResolvedValueOnce(attachmentsPage(50, 1));
    const container = await mount();

    // editing the draft query must not leak into pagination
    const input = container.querySelector<HTMLInputElement>('input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, 'draft');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const button = loadMoreButton(container);
    await act(async () => {
      button?.click();
      button?.click();
    });

    expect(mocks.messages).toHaveBeenCalledTimes(2);
    expect(mocks.messages).toHaveBeenLastCalledWith('', 'm49');
    expect(container.textContent).toContain('file-50.pdf');
    expect(loadMoreButton(container)).toBeUndefined();
  });

  it('shows the device registry notice on the devices tab', async () => {
    mocks.messages.mockResolvedValue(attachmentsPage(0, 1));
    const container = await mount();
    const deviceTab = container.querySelector<HTMLElement>('#admin-documents-tab-devices');
    await act(async () => deviceTab?.click());
    expect(container.textContent).toContain('Файловий реєстр не підключено');
  });
});
