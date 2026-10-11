/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviceFileTreeEntry } from '../../../../../../Bindings';
import type { useDeviceFilePreview } from '../../use-device-file-preview';
import { DeviceFileContentPane } from '../DeviceFileContentPane';

vi.mock('../../use-device-file-preview', () => ({ useDeviceFilePreview: () => preview }));
vi.mock('../../../shared/message-card/renderers/DocumentFilePreview', () => ({
  DocumentFilePreview: ({ zoom }: { zoom: number }) => (
    <canvas data-pdf-leaf data-zoom={zoom} width={(400 * zoom) / 100} height={(600 * zoom) / 100} />
  ),
}));

const file: DeviceFileTreeEntry = {
  entryId: 'file',
  parentEntryId: 'root',
  kind: 'file',
  fileId: 'file',
  name: 'selected.pdf',
  pathComponents: ['selected.pdf'],
  absolutePath: 'C:\\selected.pdf',
  hasContent: true,
  mimeType: 'application/pdf',
  extension: 'pdf',
  fileMetadataCreatedAt: null,
  fileMetadataModifiedAt: null,
  createdAt: '2026-10-07T00:00:00Z',
  updatedAt: '2026-10-07T00:00:00Z',
  revision: 1,
  syncId: null,
  sourceFileState: null,
  tags: [],
};
const controller = new AbortController();
const preview: ReturnType<typeof useDeviceFilePreview> = {
  state: 'ready',
  source: {
    key: 'device/file/1',
    deviceId: 'device',
    fileId: 'file',
    revision: 1,
    fileName: file.name,
    extension: 'pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    originalHref: '/api/device/files/device/file/revisions/1/content',
  },
  epoch: 1,
  signal: controller.signal,
  error: null,
  errorRetryable: true,
  canDownload: true,
  downloading: false,
  download: async () => {},
  retry: () => {},
  onError: () => {},
  registerCleanup: () => () => {},
  isCurrent: () => true,
  checkAccess: async () => true,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function openFullscreen() {
  await act(async () => root.render(<DeviceFileContentPane deviceId="device" file={file} />));
  await vi.waitFor(() => expect(container.querySelector('[data-pdf-leaf]')).not.toBeNull());
  expect(container.querySelector('[aria-label="Збільшити масштаб"]')).not.toBeNull();
  expect(
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Скачати файл'),
    )?.disabled,
  ).toBe(false);
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label="На весь екран"]')!;
  await act(async () => trigger.click());
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.querySelector('[data-pdf-leaf]')).not.toBeNull();
  return { dialog, trigger };
}

it('fullscreen keeps PDF zoom actions connected to the selected viewer', async () => {
  const { dialog } = await openFullscreen();
  const increase = dialog.querySelector<HTMLButtonElement>('[aria-label="Збільшити масштаб"]');
  expect(increase).not.toBeNull();
  await act(async () => increase!.click());
  expect(dialog.querySelector('[data-pdf-leaf]')?.getAttribute('data-zoom')).toBe('125');
  const decrease = dialog.querySelector<HTMLButtonElement>('[aria-label="Зменшити масштаб"]')!;
  await act(async () => decrease.click());
  expect(dialog.querySelector('[data-pdf-leaf]')?.getAttribute('data-zoom')).toBe('100');
});

it('fullscreen keeps the authorized original download action available', async () => {
  const { dialog } = await openFullscreen();
  const download = [...dialog.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Скачати файл'),
  );
  expect(download).toBeDefined();
  expect(download!.disabled).toBe(false);
});
