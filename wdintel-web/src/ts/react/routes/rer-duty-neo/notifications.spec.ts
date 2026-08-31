/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginDutyNotificationPollCycle,
  DUTY_NOTIFICATION_STATUS_CHANGE_EVENT,
  DutyBrowserNotificationStatus,
  endDutyNotificationPollCycle,
  getBrowserNotificationStatus,
  showBrowserNotification,
  notifyDutyNewMessages,
  setStoredDutyNotificationSettingsForFeed,
  testBrowserNotification,
} from './notifications';

const originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');

function installNotification(permission: NotificationPermission, ctor: typeof Notification) {
  vi.stubGlobal('Notification', ctor);
  Object.defineProperty(Notification, 'permission', { configurable: true, value: permission });
}

afterEach(() => {
  endDutyNotificationPollCycle();
  vi.unstubAllGlobals();
  if (originalLocalStorage) {
    Object.defineProperty(window, 'localStorage', originalLocalStorage);
  } else {
    delete (window as { localStorage?: Storage }).localStorage;
  }
});

describe('Duty browser notifications', () => {
  it('keeps production delivery separate from the explicit test path', () => {
    const NotificationMock = vi.fn(function () {
      return { addEventListener: vi.fn() };
    }) as unknown as typeof Notification;
    installNotification('granted', NotificationMock);

    showBrowserNotification('Виробниче', { silent: true });

    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenLastCalledWith('Виробниче', { silent: true });
  });

  it('publishes browser runtime-status transitions from production delivery', () => {
    const onStatusChange = vi.fn();
    window.addEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, onStatusChange);
    const failing = vi.fn(function () {
      throw new Error('blocked');
    }) as unknown as typeof Notification;
    installNotification('granted', failing);

    showBrowserNotification('Виробниче');

    expect(getBrowserNotificationStatus()).toBe(DutyBrowserNotificationStatus.RuntimeFailure);
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    const succeeding = vi.fn(function () {
      return { addEventListener: vi.fn() };
    }) as unknown as typeof Notification;
    installNotification('granted', succeeding);

    showBrowserNotification('Виробниче');

    expect(getBrowserNotificationStatus()).toBe(DutyBrowserNotificationStatus.Granted);
    expect(onStatusChange).toHaveBeenCalledTimes(2);

    showBrowserNotification('Виробниче');

    expect(onStatusChange).toHaveBeenCalledTimes(2);
    window.removeEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, onStatusChange);
  });

  it('retries an explicit test after a runtime failure and clears it on success', () => {
    const failing = vi.fn(function () {
      throw new Error('blocked');
    }) as unknown as typeof Notification;
    installNotification('granted', failing);
    expect(testBrowserNotification()).toBe(DutyBrowserNotificationStatus.RuntimeFailure);

    const succeeding = vi.fn(function () {
      return { addEventListener: vi.fn() };
    }) as unknown as typeof Notification;
    installNotification('granted', succeeding);
    expect(testBrowserNotification()).toBe(DutyBrowserNotificationStatus.Granted);
    expect(getBrowserNotificationStatus()).toBe(DutyBrowserNotificationStatus.Granted);
  });

  it('does not construct a test notification when permission is denied', () => {
    const NotificationMock = vi.fn() as unknown as typeof Notification;
    installNotification('denied', NotificationMock);
    expect(testBrowserNotification()).toBe(DutyBrowserNotificationStatus.Denied);
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  it('aggregates two feeds into one production notification and one chime', () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const NotificationMock = vi.fn(function () {
      return { addEventListener: vi.fn() };
    }) as unknown as typeof Notification;
    installNotification('granted', NotificationMock);
    const oscillator = {
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
    };
    const gain = {
      connect: vi.fn(),
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
    };
    const AudioContextMock = vi.fn(function () {
      return {
        currentTime: 0,
        state: 'running',
        destination: {},
        createGain: vi.fn(() => gain),
        createOscillator: vi.fn(() => ({ ...oscillator, frequency: { setValueAtTime: vi.fn() } })),
      };
    });
    vi.stubGlobal('AudioContext', AudioContextMock);
    setStoredDutyNotificationSettingsForFeed('feed-a', {
      soundEnabled: true,
      browserEnabled: true,
    });
    setStoredDutyNotificationSettingsForFeed('feed-b', {
      soundEnabled: true,
      browserEnabled: true,
    });
    beginDutyNotificationPollCycle();
    notifyDutyNewMessages('feed-a', 2);
    notifyDutyNewMessages('feed-b', 3);
    endDutyNotificationPollCycle();
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledWith(
      'Нові повідомлення в оперативному',
      expect.objectContaining({
        body: expect.stringContaining('Нових повідомлень: 5'),
        silent: true,
      }),
    );
    expect(NotificationMock.mock.calls[0]?.[1]?.body).toContain('Стрічок: 2');
    expect(
      AudioContextMock.mock.results[0]?.value.createOscillator as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledTimes(2);
  });

  it('aggregates browser notifications only from browser-enabled feeds while chiming once', async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const NotificationMock = vi.fn(function () {
      return { addEventListener: vi.fn() };
    }) as unknown as typeof Notification;
    installNotification('granted', NotificationMock);
    const createOscillator = vi.fn(() => ({
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
    }));
    const gain = {
      connect: vi.fn(),
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
    };
    const AudioContextMock = vi.fn(function () {
      return {
        currentTime: 0,
        state: 'running',
        destination: {},
        createGain: vi.fn(() => gain),
        createOscillator,
      };
    });
    vi.stubGlobal('AudioContext', AudioContextMock);
    vi.resetModules();
    const {
      beginDutyNotificationPollCycle: beginPollCycle,
      endDutyNotificationPollCycle: endPollCycle,
      notifyDutyNewMessages: notifyNewMessages,
      setStoredDutyNotificationSettingsForFeed: setStoredSettings,
    } = await import('./notifications');
    setStoredSettings('feed-a', {
      soundEnabled: true,
      browserEnabled: false,
    });
    setStoredSettings('feed-b', {
      soundEnabled: false,
      browserEnabled: true,
    });

    beginPollCycle();
    notifyNewMessages('feed-a', 2);
    notifyNewMessages('feed-b', 3);
    endPollCycle();

    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock.mock.calls[0]?.[1]?.body).toBe('Нових повідомлень: 3. Стрічок: 1.');
    expect(createOscillator).toHaveBeenCalledTimes(2);
  });

  it('returns Ready after playing a two-note chime on an initially running context', async () => {
    const createOscillator = vi.fn(() => ({
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
    }));
    const gain = {
      connect: vi.fn(),
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
    };
    const AudioContextMock = vi.fn(function () {
      return {
        currentTime: 0,
        state: 'running',
        destination: {},
        createGain: vi.fn(() => gain),
        createOscillator,
      };
    });
    vi.stubGlobal('AudioContext', AudioContextMock);
    vi.resetModules();
    const { DutySoundStatus, playNotificationSound } = await import('./notifications');

    await expect(playNotificationSound()).resolves.toBe(DutySoundStatus.Ready);
    expect(createOscillator).toHaveBeenCalledTimes(2);
  });

  it('keeps a playback failure blocked until a later chime succeeds', async () => {
    const gain = {
      connect: vi.fn(),
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
        exponentialRampToValueAtTime: vi.fn(),
      },
    };
    const createGain = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('chime failed');
      })
      .mockReturnValue(gain);
    const AudioContextMock = vi.fn(function () {
      return {
        currentTime: 0,
        state: 'running',
        destination: {},
        createGain,
        createOscillator: vi.fn(() => ({
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          type: 'sine',
          frequency: { setValueAtTime: vi.fn() },
        })),
      };
    });
    vi.stubGlobal('AudioContext', AudioContextMock);
    vi.resetModules();
    const {
      DUTY_NOTIFICATION_STATUS_CHANGE_EVENT: statusChangeEvent,
      DutySoundStatus,
      getDutySoundStatus: getSoundStatus,
      playNotificationSound: playSound,
      resumeDutyNotificationAudioFromUserGesture: resumeAudio,
    } = await import('./notifications');
    const onStatusChange = vi.fn();
    window.addEventListener(statusChangeEvent, onStatusChange);

    await expect(playSound()).resolves.toBe(DutySoundStatus.Blocked);
    expect(getSoundStatus()).toBe(DutySoundStatus.Blocked);
    await expect(resumeAudio()).resolves.toBe(DutySoundStatus.Blocked);
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    await expect(playSound()).resolves.toBe(DutySoundStatus.Ready);
    expect(getSoundStatus()).toBe(DutySoundStatus.Ready);
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    window.removeEventListener(statusChangeEvent, onStatusChange);
  });

  it('does not duplicate the status event after successful suspended-context playback', async () => {
    const context = {
      currentTime: 0,
      state: 'suspended' as AudioContextState,
      resume: vi.fn(),
      destination: {},
      createGain: vi.fn(() => ({
        connect: vi.fn(),
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
      })),
      createOscillator: vi.fn(() => ({
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        type: 'sine',
        frequency: { setValueAtTime: vi.fn() },
      })),
    };
    context.resume.mockImplementation(async () => {
      context.state = 'running';
    });
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        return context;
      }),
    );
    vi.resetModules();
    const {
      DUTY_NOTIFICATION_STATUS_CHANGE_EVENT: statusChangeEvent,
      DutySoundStatus,
      playNotificationSound: playSound,
    } = await import('./notifications');
    const onStatusChange = vi.fn();
    window.addEventListener(statusChangeEvent, onStatusChange);

    await expect(playSound()).resolves.toBe(DutySoundStatus.Ready);
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    window.removeEventListener(statusChangeEvent, onStatusChange);
  });

  it('publishes a settled audio-status transition from priming listeners once', async () => {
    const context = {
      currentTime: 0,
      state: 'suspended' as AudioContextState,
      resume: vi.fn(),
    };
    context.resume.mockImplementation(async () => {
      context.state = 'running';
    });
    const AudioContextMock = vi.fn(function () {
      return context;
    });
    vi.stubGlobal('AudioContext', AudioContextMock);
    vi.resetModules();
    const {
      attachDutyNotificationAudioPrimingListeners: attachPrimingListeners,
      DUTY_NOTIFICATION_STATUS_CHANGE_EVENT: statusChangeEvent,
      DutySoundStatus,
      getDutySoundStatus: getSoundStatus,
    } = await import('./notifications');
    const onStatusChange = vi.fn();
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    window.addEventListener(statusChangeEvent, onStatusChange);
    const cleanup = attachPrimingListeners();

    window.dispatchEvent(new Event('pointerdown'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(getSoundStatus()).toBe(DutySoundStatus.Ready);

    window.dispatchEvent(new Event('keydown'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(onStatusChange).toHaveBeenCalledTimes(1);
    cleanup();
    expect(removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function));
    window.removeEventListener(statusChangeEvent, onStatusChange);
  });
});
