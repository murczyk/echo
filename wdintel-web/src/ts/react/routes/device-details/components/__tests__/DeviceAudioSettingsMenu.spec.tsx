/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviceAudioAsrSettingsRsp } from '../../../../../../Bindings';
import {
  getDeviceAudioSettings,
  setDeviceAudioSettings,
} from '../../../../services/api/device-audio';
import { HttpRequestError } from '../../../../services/api/client';
import { useDeviceAudioSettings } from '../../use-device-audio-settings';
import { DeviceAudioSettingsMenu } from '../DeviceAudioSettingsMenu';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../../../services/api/device-audio', () => ({
  getDeviceAudioSettings: vi.fn(),
  setDeviceAudioSettings: vi.fn(),
}));
vi.mock('../../../../components/PowerSnackbar', () => ({
  useOptionalPowerSnackbar: () => ({ notify }),
}));
const response = (
  deviceId = 'one',
  patch: Partial<DeviceAudioAsrSettingsRsp> = {},
): DeviceAudioAsrSettingsRsp => ({
  deviceId,
  enabled: true,
  globalEnabled: true,
  canManageSetting: true,
  blockedReason: null,
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const filenameChange = vi.fn();
function Harness({ deviceId = 'one', active = true }: { deviceId?: string; active?: boolean }) {
  const settings = useDeviceAudioSettings(deviceId, active);
  return (
    <DeviceAudioSettingsMenu
      showRecordingStart={false}
      onShowRecordingStartChange={filenameChange}
      settings={settings}
    />
  );
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getDeviceAudioSettings).mockImplementation(async ({ deviceId }) => response(deviceId));
  vi.mocked(setDeviceAudioSettings).mockImplementation(async ({ deviceId, enabled }) =>
    response(deviceId, { enabled }),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render(deviceId = 'one', active = true) {
  await act(async () => root.render(<Harness deviceId={deviceId} active={active} />));
}
async function open() {
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
}
function checkbox(label = 'Автотранскрибація аудіо') {
  const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')).find(
    (item) => item.textContent?.includes(label),
  );
  expect(item, `checkbox ${label}`).toBeDefined();
  return item!;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}

it('uses stored false, refreshes on menu open and leaves the filename preference independent', async () => {
  vi.mocked(getDeviceAudioSettings).mockResolvedValue(response('one', { enabled: false }));
  await render();
  await open();
  expect(checkbox().getAttribute('aria-checked')).toBe('false');
  await click(checkbox('Показувати дату й час початку'));
  expect(filenameChange).toHaveBeenCalledWith(true);
  expect(setDeviceAudioSettings).not.toHaveBeenCalled();
  vi.mocked(getDeviceAudioSettings).mockResolvedValue(response('one'));
  await act(async () => new Promise((done) => setTimeout(done, 410)));
  await open();
  expect(checkbox().getAttribute('aria-checked')).toBe('true');
});

it('sends one explicit target and waits for acknowledgement without showing an unsaved change', async () => {
  const save = deferred<DeviceAudioAsrSettingsRsp>();
  vi.mocked(setDeviceAudioSettings).mockReturnValue(save.promise);
  await render();
  await open();
  await click(checkbox());
  await click(checkbox());
  expect(checkbox().getAttribute('aria-checked')).toBe('true');
  expect(checkbox().getAttribute('aria-disabled')).toBe('true');
  expect(checkbox().textContent).toContain('Збереження');
  expect(setDeviceAudioSettings).toHaveBeenCalledTimes(1);
  expect(vi.mocked(setDeviceAudioSettings).mock.calls[0][0]).toEqual({
    deviceId: 'one',
    enabled: false,
  });
  await act(async () => save.resolve(response('one', { enabled: false })));
  expect(checkbox().getAttribute('aria-checked')).toBe('false');
  expect(checkbox().getAttribute('aria-disabled')).not.toBe('true');
});

it('supports keyboard menu navigation and explicit checkbox activation', async () => {
  await render();
  await open();
  const filename = checkbox('Показувати дату й час початку');
  filename.focus();
  await act(async () =>
    filename.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  );
  expect(document.activeElement).toBe(checkbox());
  await act(async () =>
    checkbox().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  expect(checkbox().getAttribute('aria-checked')).toBe('false');
});

it.each(['Недостатньо прав для зміни налаштування', 'Пристрій архівовано'])(
  'shows readonly reason: %s',
  async (reason) => {
    vi.mocked(getDeviceAudioSettings).mockResolvedValue(
      response('one', { canManageSetting: false, blockedReason: reason }),
    );
    await render();
    await open();
    expect(checkbox().getAttribute('aria-disabled')).toBe('true');
    expect(checkbox().textContent).toContain(reason);
    await click(checkbox());
    expect(setDeviceAudioSettings).not.toHaveBeenCalled();
  },
);

it('preserves the device choice while the global service is off and permits preference edits', async () => {
  vi.mocked(getDeviceAudioSettings).mockResolvedValue(
    response('one', { globalEnabled: false, blockedReason: 'Сервіс транскрибації вимкнено' }),
  );
  await render();
  await open();
  expect(checkbox().getAttribute('aria-checked')).toBe('true');
  expect(checkbox().getAttribute('aria-disabled')).not.toBe('true');
  expect(checkbox().textContent).toContain('Сервіс транскрибації вимкнено');
  await click(checkbox());
  expect(checkbox().getAttribute('aria-checked')).toBe('false');
});

it('reconciles an ambiguous save before allowing another mutation and reports the error', async () => {
  await render();
  await open();
  const read = deferred<DeviceAudioAsrSettingsRsp>();
  vi.mocked(setDeviceAudioSettings).mockRejectedValue(new TypeError('connection lost'));
  vi.mocked(getDeviceAudioSettings).mockReturnValue(read.promise);
  await click(checkbox());
  expect(checkbox().getAttribute('aria-disabled')).toBe('true');
  expect(checkbox().getAttribute('aria-checked')).toBe('true');
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ severity: 'error' }));
  await act(async () => read.resolve(response('one', { enabled: false })));
  expect(checkbox().getAttribute('aria-checked')).toBe('false');
  expect(checkbox().getAttribute('aria-disabled')).not.toBe('true');
});

it('keeps unknown state disabled after a failed reread until the menu can load again', async () => {
  await render();
  await open();
  vi.mocked(setDeviceAudioSettings).mockRejectedValue(new TypeError('lost'));
  vi.mocked(getDeviceAudioSettings).mockRejectedValue(new TypeError('offline'));
  await click(checkbox());
  expect(checkbox().getAttribute('aria-disabled')).toBe('true');
  expect(checkbox().textContent).toContain('Не вдалося');
  expect(notify).toHaveBeenCalled();
});

it('ignores old read and save responses after a device change', async () => {
  await render();
  await open();
  const save = deferred<DeviceAudioAsrSettingsRsp>();
  vi.mocked(setDeviceAudioSettings).mockReturnValue(save.promise);
  await click(checkbox());
  await render('two');
  await act(async () => save.resolve(response('one', { enabled: false })));
  expect(checkbox().getAttribute('aria-checked')).toBe('true');
  const read = deferred<DeviceAudioAsrSettingsRsp>();
  vi.mocked(getDeviceAudioSettings).mockReturnValueOnce(read.promise);
  await render('three');
  await render('four');
  await act(async () => read.resolve(response('three', { enabled: false })));
  expect(checkbox().getAttribute('aria-checked')).toBe('true');
  await click(checkbox());
  expect(vi.mocked(setDeviceAudioSettings).mock.calls.at(-1)![0]).toEqual({
    deviceId: 'four',
    enabled: false,
  });
});

it('never writes after denial or while the audio context is inactive', async () => {
  await render();
  await open();
  vi.mocked(setDeviceAudioSettings).mockRejectedValue(new HttpRequestError(403, 'forbidden'));
  vi.mocked(getDeviceAudioSettings).mockResolvedValue(
    response('one', {
      canManageSetting: false,
      blockedReason: 'Недостатньо прав для зміни налаштування',
    }),
  );
  await click(checkbox());
  expect(checkbox().getAttribute('aria-disabled')).toBe('true');
  await render('one', false);
  await click(checkbox());
  expect(setDeviceAudioSettings).toHaveBeenCalledTimes(1);
});
