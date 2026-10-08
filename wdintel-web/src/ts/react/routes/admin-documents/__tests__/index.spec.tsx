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

describe('AdminDocumentsPage', () => {
  it('shows message attachments in a table and switches tabs', async () => {
    mocks.messages.mockResolvedValue({
      settings: { ...settings, backfillComplete: true },
      counts: [{ kind: 'summary', state: 'done', count: 2 }],
      engines: [],
      documents: [
        {
          mediaId: 'm1',
          messageId: 1,
          messageUuid: null,
          fileName: 'report.pdf',
          contentType: 'application/pdf',
          state: 'done',
          quality: null,
          complete: true,
          revision: null,
          summary: 'Короткий підсумок',
          summaryState: 'done',
          positionState: 'pending',
          chunkCount: 3,
          lastError: null,
          snippet: null,
          citation: '',
        },
      ],
    });
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

    expect(container.textContent).toContain('report.pdf');
    expect(container.textContent).toContain('Короткий підсумок');
    expect(container.textContent).toContain('summary / done: 2');

    const deviceTab = container.querySelector<HTMLElement>('#admin-documents-tab-devices');
    await act(async () => deviceTab?.click());
    expect(container.textContent).toContain('Файловий реєстр не підключено');
  });
});
