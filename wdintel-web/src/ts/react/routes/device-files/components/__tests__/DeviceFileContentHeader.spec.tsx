/** @vitest-environment happy-dom */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { useDeviceFilePreview } from '../../use-device-file-preview';
import { DeviceFileContentActions } from '../DeviceFileContentHeader';

let root: Root;
let container: HTMLDivElement;
let completeDownload: () => void;

function Harness() {
  const [downloading, setDownloading] = useState(false);
  const preview = {
    state: 'ready',
    canDownload: true,
    downloading,
    download: async () => {
      setDownloading(true);
      await new Promise<void>((resolve) => (completeDownload = resolve));
      setDownloading(false);
    },
  } as ReturnType<typeof useDeviceFilePreview>;
  return (
    <>
      <DeviceFileContentActions preview={preview} />
      <button data-other>Інша дія</button>
    </>
  );
}

beforeEach(async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
  container.remove();
  document.body.removeAttribute('tabindex');
});

async function startDownload() {
  const button = container.querySelector<HTMLButtonElement>('button')!;
  button.focus();
  await act(async () => button.click());
  expect(button.disabled).toBe(true);
  document.body.tabIndex = -1;
  document.body.focus();
  return button;
}

it('restores the download action focus after an async save leaves focus on the body', async () => {
  const button = await startDownload();
  expect(document.activeElement).toBe(document.body);
  await act(async () => completeDownload());
  expect(button.disabled).toBe(false);
  expect(document.activeElement).toBe(button);
});

it('preserves focus moved to another action while downloading', async () => {
  await startDownload();
  const other = container.querySelector<HTMLButtonElement>('[data-other]')!;
  other.focus();
  await act(async () => completeDownload());
  expect(document.activeElement).toBe(other);
});

it('accepts the first download of a new session immediately after the previous save', async () => {
  vi.useFakeTimers();
  const download = vi.fn().mockResolvedValue(undefined);
  const preview = {
    state: 'ready',
    canDownload: true,
    downloading: false,
    epoch: 1,
    download,
  } as ReturnType<typeof useDeviceFilePreview>;
  await act(async () => root.render(<DeviceFileContentActions preview={preview} />));
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(download).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(download).toHaveBeenCalledTimes(1);
  await act(async () =>
    root.render(<DeviceFileContentActions preview={{ ...preview, epoch: 2 }} />),
  );
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(download).toHaveBeenCalledTimes(2);
});
