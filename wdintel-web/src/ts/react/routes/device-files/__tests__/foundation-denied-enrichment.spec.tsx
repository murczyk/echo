/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceDocumentReadRsp, DeviceFileTreeEntry } from '../../../../../Bindings';
import { DeviceFileContentPane } from '../components/DeviceFileContentPane';

const file: DeviceFileTreeEntry = {
  entryId: 'entry',
  parentEntryId: 'root',
  kind: 'file',
  fileId: 'file',
  name: 'notes.bin',
  pathComponents: ['notes.bin'],
  absolutePath: 'C:\\private\\notes.bin',
  hasContent: true,
  mimeType: 'application/octet-stream',
  extension: 'bin',
  contentUploadedAt: null,
  fileMetadataCreatedAt: null,
  fileMetadataModifiedAt: null,
  createdAt: '2026-10-07T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
  revision: 1,
  syncId: null,
  sourceFileState: null,
  tags: [],
};
const enrichment: DeviceDocumentReadRsp = {
  document: {
    deviceId: 'device',
    fileId: 'file',
    revision: 1,
    fileName: file.name,
    path: file.name,
    format: 'bin',
    modifiedAt: null,
    current: true,
    hasContent: true,
    state: 'completed',
    extractionRevision: null,
    complete: true,
    summary: 'Sensitive selected-file summary',
    summaryState: 'completed',
    positionState: 'completed',
    snippet: null,
    citation: '',
  },
  sections: [],
  nextAfter: null,
  warnings: [],
  coordinates: [],
  positions: [],
};
let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn<typeof fetch>();
const head = () => new Response(null, { headers: { 'content-length': '10' } });
const documentResponse = (nextAfter: number | null = null) =>
  new Response(JSON.stringify({ ...enrichment, nextAfter }));
function download() {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Скачати файл'),
  )!;
}
async function show(selected: DeviceFileTreeEntry = file, showDocumentDetails = false) {
  await act(async () =>
    root.render(
      <DeviceFileContentPane
        deviceId="device"
        file={selected}
        showDocumentDetails={showDocumentDetails}
      />,
    ),
  );
}
async function expand() {
  await act(async () => {
    const details = container.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
}
function infoButton() {
  return container.querySelector<HTMLButtonElement>('button[aria-label="Інформація"]');
}
function infoDialog() {
  return document.querySelector('[role="dialog"][aria-label="Інформація про вкладення"]');
}
async function openInfo() {
  await act(async () => infoButton()!.click());
  expect(infoDialog()).not.toBeNull();
}
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('Device file information access #3930', () => {
  it('erases open metadata and disables download after checked original download is forbidden', async () => {
    fetchMock
      .mockResolvedValueOnce(head())
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    await show();
    await openInfo();
    expect(infoDialog()!.textContent).toContain(file.absolutePath);
    expect(infoDialog()!.textContent).toContain(
      '/api/device/files/device/file/revisions/1/content',
    );
    await act(async () => download().click());
    await vi.waitFor(() => expect(infoDialog()).toBeNull());
    expect(document.body.textContent).not.toContain(file.absolutePath);
    expect(infoButton()).toBeNull();
    expect(container.querySelector('details')).toBeNull();
    expect(download().disabled).toBe(true);
    expect(fetchMock.mock.calls.every(([, options]) => options?.method === 'HEAD')).toBe(true);
  });

  it.each(['file', 'revision'])(
    'closes open metadata when the selected %s changes',
    async (change) => {
      fetchMock.mockImplementation(async () => head());
      await show();
      await openInfo();
      expect(infoDialog()!.textContent).toContain(file.absolutePath);
      const selected =
        change === 'revision'
          ? { ...file, revision: 2 }
          : {
              ...file,
              entryId: 'other',
              fileId: 'other',
              name: 'other.bin',
              absolutePath: 'C:\\other.bin',
            };
      await show(selected);
      await vi.waitFor(() => expect(infoDialog()).toBeNull());
      await openInfo();
      expect(infoDialog()!.textContent).toContain(
        `/api/device/files/device/${selected.fileId}/revisions/${selected.revision}/content`,
      );
      expect(infoDialog()!.textContent).not.toContain(
        '/api/device/files/device/file/revisions/1/content',
      );
      expect(container.querySelector('details')).toBeNull();
      expect(fetchMock.mock.calls.every(([, options]) => options?.method === 'HEAD')).toBe(true);
    },
  );
});

describe('Foundation denial erases opted-in AI file enrichment', () => {
  it('removes loaded enrichment and disables download after loading more sections is forbidden', async () => {
    fetchMock
      .mockResolvedValueOnce(head())
      .mockResolvedValueOnce(documentResponse(0))
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    await show(file, true);
    await expand();
    expect(container.textContent).toContain(enrichment.document.summary);
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Наступні розділи')!
        .click();
    });
    expect(container.querySelector('details')).toBeNull();
    expect(container.textContent).not.toContain(enrichment.document.summary);
    expect(download().disabled).toBe(true);
  });

  it('aborts pending enrichment and rejects its late result after checked original download is denied', async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => {
      resolve = done;
    });
    fetchMock
      .mockResolvedValueOnce(head())
      .mockImplementationOnce(() => pending)
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    await show(file, true);
    await expand();
    const signal = fetchMock.mock.calls[1][1]?.signal;
    await act(async () => download().click());
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(documentResponse()));
    expect(container.querySelector('details')).toBeNull();
    expect(container.textContent).not.toContain(enrichment.document.summary);
    expect(download().disabled).toBe(true);
  });
});
