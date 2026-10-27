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
  absolutePath: null,
  hasContent: true,
  mimeType: 'application/octet-stream',
  extension: 'bin',
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
const documentResponse = () => new Response(JSON.stringify(enrichment));
function download() {
  return [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Скачати файл'),
  )!;
}
async function show() {
  await act(async () => root.render(<DeviceFileContentPane deviceId="device" file={file} />));
}
async function expand() {
  await act(async () => {
    const details = container.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
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

// Authorization erasure boundary: specs/002-device-file-formats/contracts/ui.md.
describe('Foundation denial erases selected-file enrichment', () => {
  it('removes loaded enrichment and disables download after its own refresh is forbidden', async () => {
    fetchMock
      .mockResolvedValueOnce(head())
      .mockResolvedValueOnce(documentResponse())
      .mockResolvedValueOnce(new Response('Forbidden', { status: 403 }));
    await show();
    await expand();
    expect(container.textContent).toContain(enrichment.document.summary);
    await act(async () => {
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent === 'Оновити')!
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
    await show();
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
