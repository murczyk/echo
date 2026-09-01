/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedNotificationPanel } from './FeedNotificationPanel';

const api = vi.hoisted(() => ({
  getStored: vi.fn(() => ({ soundEnabled: false, browserEnabled: false })),
  setStored: vi.fn(() => ({ ok: true as const })),
  resume: vi.fn(async () => 'ready'),
  play: vi.fn(async () => 'ready'),
  browserStatus: vi.fn(() => 'granted'),
  soundStatus: vi.fn(() => 'ready'),
  testBrowser: vi.fn(() => 'granted'),
  permission: vi.fn(async () => 'denied'),
}));
const DUTY_NOTIFICATION_STATUS_CHANGE_EVENT = 'duty-notification-status-change';
vi.mock('./notifications', () => ({
  DUTY_NOTIFICATION_STATUS_CHANGE_EVENT: 'duty-notification-status-change',
  DutyBrowserNotificationStatus: {
    Granted: 'granted',
    RuntimeFailure: 'runtime-failure',
    Denied: 'denied',
    NotRequested: 'not-requested',
    Unsupported: 'unsupported',
  },
  DutySoundStatus: {
    Ready: 'ready',
    InteractionRequired: 'interaction-required',
    Blocked: 'blocked',
    Unsupported: 'unsupported',
  },
  getStoredDutyNotificationSettingsForFeed: api.getStored,
  setStoredDutyNotificationSettingsForFeed: api.setStored,
  resumeDutyNotificationAudioFromUserGesture: api.resume,
  playNotificationSound: api.play,
  getBrowserNotificationStatus: api.browserStatus,
  getDutySoundStatus: api.soundStatus,
  testBrowserNotification: api.testBrowser,
  requestBrowserNotificationPermission: api.permission,
  getLastSuccessfulDutyCountCheck: vi.fn(() => null),
}));

let cleanup: (() => void) | null = null;
let storedSettings = { soundEnabled: false, browserEnabled: false };

beforeEach(() => {
  storedSettings = { soundEnabled: false, browserEnabled: false };
  api.getStored.mockReset();
  api.getStored.mockImplementation(() => storedSettings);
  api.setStored.mockReset();
  api.setStored.mockImplementation((_, settings) => {
    storedSettings = settings;
    return { ok: true };
  });
  api.resume.mockReset();
  api.resume.mockResolvedValue('ready');
  api.play.mockReset();
  api.play.mockResolvedValue('ready');
  api.browserStatus.mockReset();
  api.browserStatus.mockReturnValue('granted');
  api.soundStatus.mockReset();
  api.soundStatus.mockReturnValue('ready');
  api.testBrowser.mockReset();
  api.testBrowser.mockReturnValue('granted');
  api.permission.mockReset();
  api.permission.mockResolvedValue('denied');
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
});

async function renderPanel(
  props: Partial<React.ComponentProps<typeof FeedNotificationPanel>> = {},
) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const panelProps: React.ComponentProps<typeof FeedNotificationPanel> = {
    feedId: 'f',
    storageError: null,
    onStorageErrorChange: vi.fn(),
    onNotificationStatusChanged: vi.fn(),
    ...props,
  };
  await act(async () => {
    root.render(<FeedNotificationPanel {...panelProps} />);
  });
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  return { container, ...panelProps };
}

function getSwitch(container: HTMLElement, label: string): HTMLInputElement {
  const control = Array.from(container.querySelectorAll('label')).find((element) =>
    element.textContent?.includes(label),
  );
  const input = control?.querySelector('input');
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing switch: ${label}`);
  return input;
}

function getButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent === label,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return button;
}

describe('FeedNotificationPanel', () => {
  it('plays sound and reports its status when testing sound', async () => {
    storedSettings = { soundEnabled: true, browserEnabled: false };
    const changed = vi.fn();
    const { container } = await renderPanel({ onNotificationStatusChanged: changed });

    await act(async () => {
      getButton(container, 'Перевірити звук').click();
    });

    expect(api.play).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('tests browser notifications and reports their status', async () => {
    storedSettings = { soundEnabled: false, browserEnabled: true };
    const changed = vi.fn();
    const { container } = await renderPanel({ onNotificationStatusChanged: changed });

    await act(async () => {
      getButton(container, 'Перевірити банер').click();
    });

    expect(api.testBrowser).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('shows system guidance after a successful browser test', async () => {
    storedSettings = { soundEnabled: false, browserEnabled: true };
    const { container } = await renderPanel();
    await act(async () => {
      getButton(container, 'Перевірити банер').click();
    });
    expect(container.textContent).toContain('Банер не з’явився?');
    await act(async () => {
      getButton(container, 'Перевірити системні налаштування').click();
    });
    expect(document.body.textContent).toContain('Windows');
  });

  it('opens Chrome guidance for a denied browser status', async () => {
    api.browserStatus.mockReturnValue('denied');
    const { container } = await renderPanel();
    expect(container.textContent).toContain('Сповіщення заборонені');
    await act(async () => {
      getButton(container, 'Як виправити').click();
    });
    expect(document.body.textContent).toContain('Дозвіл у Chrome');
  });

  it('navigates from runtime browser diagnostics to system instructions', async () => {
    api.browserStatus.mockReturnValue('runtime-failure');
    const { container } = await renderPanel();

    await act(async () => {
      getButton(container, 'Як виправити').click();
    });
    expect(document.body.textContent).toContain('Як знайти причину');

    await act(async () => {
      getButton(document.body, 'Перевірка банера спрацювала, але банер не з’явився?').click();
    });
    expect(document.body.textContent).toContain('Системні параметри → Сповіщення → Google Chrome');
  });

  it('opens Chrome help when browser permission is not granted', async () => {
    api.browserStatus.mockReturnValue('runtime-failure');
    const { container } = await renderPanel();

    await act(async () => {
      getButton(container, 'Інструкція').click();
    });

    expect(document.body.textContent).toContain('Дозвіл у Chrome');
    expect(document.body.textContent).toContain('Відомості про сайт');
  });

  it('refreshes browser status from the shared notification-status event', async () => {
    const { container } = await renderPanel();

    api.browserStatus.mockReturnValue('runtime-failure');
    await act(async () => {
      window.dispatchEvent(new Event(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT));
    });

    expect(container.textContent).toContain('Браузеру не вдалося створити системний банер.');
  });

  it('tests sound from instructions when the operational channel is disabled', async () => {
    const changed = vi.fn();
    const { container } = await renderPanel({ onNotificationStatusChanged: changed });

    await act(async () => {
      getButton(container, 'Інструкція').click();
    });
    expect(document.body.textContent).toContain('Налаштування та діагностика сповіщень');

    await act(async () => {
      getButton(document.body, 'Перевірити звук').click();
    });
    expect(api.play).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('does not persist after denied browser permission', async () => {
    const changed = vi.fn();
    const persisted = vi.fn();
    const { container } = await renderPanel({
      onNotificationStatusChanged: changed,
      onPersisted: persisted,
    });

    await act(async () => {
      getSwitch(container, 'Системний банер').click();
    });

    expect(api.permission).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(api.setStored).not.toHaveBeenCalled();
    expect(persisted).not.toHaveBeenCalled();
  });

  it('reports storage failure without persisting panel state', async () => {
    api.setStored.mockReturnValueOnce({ ok: false, error: 'quota' });
    const changed = vi.fn();
    const persisted = vi.fn();
    api.getStored.mockReturnValue({ soundEnabled: true, browserEnabled: false });
    const { container } = await renderPanel({
      onStorageErrorChange: changed,
      onPersisted: persisted,
    });
    const sound = getSwitch(container, 'Звуковий сигнал');
    await act(async () => sound.click());
    expect(changed).toHaveBeenCalledWith('quota');
    expect(persisted).not.toHaveBeenCalled();
    expect(sound.checked).toBe(true);
  });

  it('keeps the sound switch checked after failed persistence', async () => {
    api.getStored.mockReturnValue({ soundEnabled: true, browserEnabled: false });
    api.setStored.mockReturnValue({ ok: false, error: 'quota' });
    const error = vi.fn();
    const persisted = vi.fn();
    const { container } = await renderPanel({
      feedId: 'failed',
      onStorageErrorChange: error,
      onPersisted: persisted,
    });
    const sound = getSwitch(container, 'Звуковий сигнал');
    await act(async () => sound.click());
    expect(api.setStored).toHaveBeenCalledWith('failed', {
      soundEnabled: false,
      browserEnabled: false,
    });
    expect(error).toHaveBeenCalledWith('quota');
    expect(persisted).not.toHaveBeenCalled();
    expect(sound.checked).toBe(true);
  });

  it('clears an existing error after successful persistence', async () => {
    api.getStored.mockReturnValue({ soundEnabled: true, browserEnabled: false });
    api.setStored.mockReturnValue({ ok: true });
    const error = vi.fn();
    const persisted = vi.fn();
    const { container } = await renderPanel({
      feedId: 'success',
      storageError: 'old error',
      onStorageErrorChange: error,
      onPersisted: persisted,
    });
    const sound = getSwitch(container, 'Звуковий сигнал');
    await act(async () => sound.click());
    expect(error).toHaveBeenCalledWith(null);
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(sound.checked).toBe(false);
  });

  it('merges concurrent switch writes with the latest stored settings', async () => {
    let resume!: () => void;
    api.resume.mockImplementation(
      () =>
        new Promise((resolve) => {
          resume = () => resolve('ready');
        }),
    );
    api.permission.mockResolvedValue('granted');
    const { container } = await renderPanel();
    const sound = getSwitch(container, 'Звуковий сигнал');
    const browser = getSwitch(container, 'Системний банер');

    await act(async () => {
      sound.click();
      await Promise.resolve();
    });
    await act(async () => {
      browser.click();
    });

    expect(api.setStored).toHaveBeenLastCalledWith('f', {
      soundEnabled: false,
      browserEnabled: true,
    });

    await act(async () => {
      resume();
    });

    expect(api.setStored).toHaveBeenLastCalledWith('f', {
      soundEnabled: true,
      browserEnabled: true,
    });
    expect(sound.checked).toBe(true);
    expect(browser.checked).toBe(true);
  });
});
