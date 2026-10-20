/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PowerSnackbarProvider } from '../../../components/PowerSnackbar';
import { useDeviceFileDownload } from '../use-device-file-download';

const source = { deviceId: 'device', fileId: 'file', revision: 8 };
const href = '/api/device/files/device/file/revisions/8/content';
const fetchMock = vi.fn<typeof fetch>();
let latest: ReturnType<typeof useDeviceFileDownload>;
let root: Root;
let container: HTMLDivElement;
let downloads: string[];
function Harness() {
  latest = useDeviceFileDownload(source);
  return null;
}
beforeEach(async () => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  downloads = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
    downloads.push(this.getAttribute('href')!);
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <PowerSnackbarProvider>
        <Harness />
      </PowerSnackbarProvider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('preflights exact revision with HEAD and starts one native content download', async () => {
  fetchMock.mockResolvedValue(new Response(null, { headers: { 'content-length': '5000000000' } }));
  await act(async () => {
    await latest.download();
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][0]).toBe(href);
  expect(fetchMock.mock.calls[0][1]?.method).toBe('HEAD');
  expect(downloads).toEqual([href]);
});

it('reports preflight failure and does not start a download', async () => {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ message: 'Немає доступу' }), { status: 403 }),
  );
  await act(async () => {
    await latest.download();
  });
  expect(downloads).toEqual([]);
  expect(document.body.textContent).toContain('Помилка скачування файлу');
});

it('coalesces repeated clicks while preflight is pending', async () => {
  let finish!: (value: Response) => void;
  fetchMock.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    void latest.download();
    void latest.download();
  });
  expect(fetchMock).toHaveBeenCalledOnce();
  await act(async () => {
    finish(new Response(null));
  });
  expect(downloads).toEqual([href]);
});
