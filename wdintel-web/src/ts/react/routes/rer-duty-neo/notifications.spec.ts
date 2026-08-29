/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginDutyNotificationPollCycle,
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
});
