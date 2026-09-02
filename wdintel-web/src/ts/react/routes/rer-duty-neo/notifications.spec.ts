/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginDutyNotificationPollCycle,
  cancelDutyNotificationPollCycle,
  DUTY_NOTIFICATION_STATUS_CHANGE_EVENT,
  DutyBrowserNotificationStatus,
  endDutyNotificationPollCycle,
  getBrowserNotificationStatus,
  showBrowserNotification,
  notifyDutyNewMessages,
  registerDutyNotificationPreview,
  requestBrowserNotificationPermission,
  setStoredDutyNotificationSettingsForFeed,
  testBrowserNotification,
} from './notifications';

const originalLocalStorage = Object.getOwnPropertyDescriptor(window, 'localStorage');

function installNotification(permission: NotificationPermission, ctor: typeof Notification) {
  vi.stubGlobal('Notification', ctor);
  Object.defineProperty(Notification, 'permission', { configurable: true, value: permission });
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalLocalStorage) {
    Object.defineProperty(window, 'localStorage', originalLocalStorage);
  } else {
    delete (window as { localStorage?: Storage }).localStorage;
  }
});

describe('Duty browser notifications', () => {
  // Regression: https://github.com/echoua/echo/pull/3331
  it('suppresses stale previews and previews invalidated after an ended cycle', async () => {
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
    setStoredDutyNotificationSettingsForFeed('feed-a', {
      soundEnabled: false,
      browserEnabled: true,
    });

    const stale = beginDutyNotificationPollCycle();
    registerDutyNotificationPreview(stale, 'feed-a', async () => ({ kind: 'stale' }));
    notifyDutyNewMessages('feed-a', 1, stale);
    endDutyNotificationPollCycle(stale);
    await Promise.resolve();
    expect(NotificationMock).not.toHaveBeenCalled();

    let resolvePreview!: (value: {
      kind: 'ready';
      preview: { messageId: number; timestamp: number; title: string; body: string };
    }) => void;
    const pending = new Promise<{
      kind: 'ready';
      preview: { messageId: number; timestamp: number; title: string; body: string };
    }>((resolve) => {
      resolvePreview = resolve;
    });
    const cancelled = beginDutyNotificationPollCycle();
    registerDutyNotificationPreview(cancelled, 'feed-a', () => pending);
    notifyDutyNewMessages('feed-a', 1, cancelled);
    endDutyNotificationPollCycle(cancelled);
    cancelDutyNotificationPollCycle(cancelled);
    resolvePreview({
      kind: 'ready',
      preview: { messageId: 1, timestamp: 1, title: 'Sender', body: 'Body' },
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(NotificationMock).not.toHaveBeenCalled();
  });

  // Regression: https://github.com/echoua/echo/pull/3331
  it('rechecks browser settings before a pending rich preview is delivered', async () => {
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
    setStoredDutyNotificationSettingsForFeed('feed-a', {
      soundEnabled: false,
      browserEnabled: true,
    });
    let resolvePreview!: (value: {
      kind: 'ready';
      preview: { messageId: number; timestamp: number; title: string; body: string };
    }) => void;
    const pending = new Promise<{
      kind: 'ready';
      preview: { messageId: number; timestamp: number; title: string; body: string };
    }>((resolve) => {
      resolvePreview = resolve;
    });
    const cycle = beginDutyNotificationPollCycle();
    registerDutyNotificationPreview(cycle, 'feed-a', () => pending);
    notifyDutyNewMessages('feed-a', 1, cycle);
    endDutyNotificationPollCycle(cycle);
    setStoredDutyNotificationSettingsForFeed('feed-a', {
      soundEnabled: false,
      browserEnabled: false,
    });
    resolvePreview({
      kind: 'ready',
      preview: { messageId: 1, timestamp: 1, title: 'Sender', body: 'Body' },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(NotificationMock).not.toHaveBeenCalled();

    const disabled = beginDutyNotificationPollCycle();
    const loader = vi.fn(async () => ({
      kind: 'ready' as const,
      preview: { messageId: 2, timestamp: 2, title: 'Sender', body: 'Body' },
    }));
    registerDutyNotificationPreview(disabled, 'feed-a', loader);
    notifyDutyNewMessages('feed-a', 1, disabled);
    endDutyNotificationPollCycle(disabled);
    expect(loader).not.toHaveBeenCalled();
  });

  // Regression: https://github.com/echoua/echo/pull/3331
  it('aggregates ready previews into the newest unique rich notification', async () => {
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
    for (const feedId of ['stale', 'old', 'new', 'duplicate'])
      setStoredDutyNotificationSettingsForFeed(feedId, {
        soundEnabled: false,
        browserEnabled: true,
      });
    const cycle = beginDutyNotificationPollCycle();
    registerDutyNotificationPreview(cycle, 'stale', async () => ({ kind: 'stale' }));
    registerDutyNotificationPreview(cycle, 'old', async () => ({
      kind: 'ready',
      preview: { messageId: 4, timestamp: 10, title: 'Old', body: 'Old body' },
    }));
    registerDutyNotificationPreview(cycle, 'new', async () => ({
      kind: 'ready',
      preview: { messageId: 5, timestamp: 20, title: 'New', body: 'New body' },
    }));
    registerDutyNotificationPreview(cycle, 'duplicate', async () => ({
      kind: 'ready',
      preview: { messageId: 5, timestamp: 20, title: 'Duplicate', body: 'Duplicate body' },
    }));
    for (const feedId of ['stale', 'old', 'new', 'duplicate'])
      notifyDutyNewMessages(feedId, 1, cycle);
    endDutyNotificationPollCycle(cycle);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenLastCalledWith(
      'Duplicate',
      expect.objectContaining({ body: 'Duplicate body', silent: true }),
    );
  });

  // Regression: https://github.com/echoua/echo/pull/3331
  it('starts one sound event before a pending preview settles and does not repeat it on failure', async () => {
    const values = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      },
    });
    const createOscillator = vi.fn(() => ({
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
    }));
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        return {
          currentTime: 0,
          state: 'running',
          destination: {},
          createGain: vi.fn(() => ({
            connect: vi.fn(),
            gain: {
              setValueAtTime: vi.fn(),
              linearRampToValueAtTime: vi.fn(),
              exponentialRampToValueAtTime: vi.fn(),
            },
          })),
          createOscillator,
        };
      }),
    );
    vi.resetModules();
    const notifications = await import('./notifications');
    const pending = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('preview failed')), 0),
    );
    notifications.setStoredDutyNotificationSettingsForFeed('feed-a', {
      soundEnabled: true,
      browserEnabled: true,
    });
    const cycle = notifications.beginDutyNotificationPollCycle();
    notifications.registerDutyNotificationPreview(cycle, 'feed-a', () => pending);
    notifications.notifyDutyNewMessages('feed-a', 1, cycle);
    notifications.endDutyNotificationPollCycle(cycle);
    expect(createOscillator).toHaveBeenCalledTimes(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    expect(createOscillator).toHaveBeenCalledTimes(2);
  });

  it('keeps concurrent poll cycles isolated until each is ended', () => {
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
    setStoredDutyNotificationSettingsForFeed('feed-a', {
      soundEnabled: false,
      browserEnabled: true,
    });
    setStoredDutyNotificationSettingsForFeed('feed-b', {
      soundEnabled: false,
      browserEnabled: true,
    });
    const first = beginDutyNotificationPollCycle();
    const second = beginDutyNotificationPollCycle();
    notifyDutyNewMessages('feed-a', 2, first);
    notifyDutyNewMessages('feed-b', 3, second);

    endDutyNotificationPollCycle(first);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock.mock.calls[0]?.[1]?.body).toBe(
      'Відкрийте «Оперативний», щоб переглянути.',
    );

    endDutyNotificationPollCycle(second);
    expect(NotificationMock).toHaveBeenCalledTimes(2);
    expect(NotificationMock.mock.calls[1]?.[1]?.body).toBe(
      'Відкрийте «Оперативний», щоб переглянути.',
    );
  });

  it('cancels buffered alerts and suppresses late notifications for that cycle', () => {
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
    setStoredDutyNotificationSettingsForFeed('feed-a', {
      soundEnabled: false,
      browserEnabled: true,
    });
    const cycle = beginDutyNotificationPollCycle();
    notifyDutyNewMessages('feed-a', 2, cycle);
    cancelDutyNotificationPollCycle(cycle);
    endDutyNotificationPollCycle(cycle);
    notifyDutyNewMessages('feed-a', 3, cycle);
    expect(NotificationMock).not.toHaveBeenCalled();

    notifyDutyNewMessages('feed-a', 1);
    expect(NotificationMock).toHaveBeenCalledTimes(1);

    const ended = beginDutyNotificationPollCycle();
    endDutyNotificationPollCycle(ended);
    notifyDutyNewMessages('feed-a', 1, ended);
    expect(NotificationMock).toHaveBeenCalledTimes(2);
    cancelDutyNotificationPollCycle(ended);
    notifyDutyNewMessages('feed-a', 1, ended);
    expect(NotificationMock).toHaveBeenCalledTimes(2);
  });

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

  it('publishes permission-request failure and recovery transitions', async () => {
    const requestPermission = vi
      .fn()
      .mockRejectedValueOnce(new Error('blocked'))
      .mockResolvedValueOnce('default' as NotificationPermission);
    const NotificationMock = Object.assign(vi.fn(), {
      requestPermission,
    }) as unknown as typeof Notification;
    installNotification('default', NotificationMock);
    const onStatusChange = vi.fn();
    window.addEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, onStatusChange);

    await expect(requestBrowserNotificationPermission()).resolves.toBe('denied');
    expect(getBrowserNotificationStatus()).toBe(DutyBrowserNotificationStatus.RuntimeFailure);
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    await expect(requestBrowserNotificationPermission()).resolves.toBe('default');
    expect(getBrowserNotificationStatus()).toBe(DutyBrowserNotificationStatus.NotRequested);
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    window.removeEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, onStatusChange);
  });

  it('reconciles an externally granted permission after a runtime failure', async () => {
    const requestPermission = vi.fn().mockRejectedValueOnce(new Error('blocked'));
    const NotificationMock = Object.assign(vi.fn(), {
      requestPermission,
    }) as unknown as typeof Notification;
    installNotification('default', NotificationMock);
    const onStatusChange = vi.fn();
    window.addEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, onStatusChange);

    await expect(requestBrowserNotificationPermission()).resolves.toBe('denied');
    expect(getBrowserNotificationStatus()).toBe(DutyBrowserNotificationStatus.RuntimeFailure);
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    Object.defineProperty(Notification, 'permission', { configurable: true, value: 'granted' });
    await expect(requestBrowserNotificationPermission()).resolves.toBe('granted');
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(getBrowserNotificationStatus()).toBe(DutyBrowserNotificationStatus.Granted);
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    window.removeEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, onStatusChange);
  });

  it('publishes explicit test failure and recovery transitions once each', () => {
    const onStatusChange = vi.fn();
    window.addEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, onStatusChange);
    const failing = vi.fn(function () {
      throw new Error('blocked');
    }) as unknown as typeof Notification;
    installNotification('granted', failing);
    expect(testBrowserNotification()).toBe(DutyBrowserNotificationStatus.RuntimeFailure);
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    const succeeding = vi.fn(function () {
      return { addEventListener: vi.fn() };
    }) as unknown as typeof Notification;
    installNotification('granted', succeeding);
    expect(testBrowserNotification()).toBe(DutyBrowserNotificationStatus.Granted);
    expect(getBrowserNotificationStatus()).toBe(DutyBrowserNotificationStatus.Granted);
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    expect(testBrowserNotification()).toBe(DutyBrowserNotificationStatus.Granted);
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    window.removeEventListener(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT, onStatusChange);
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
    const cycle = beginDutyNotificationPollCycle();
    notifyDutyNewMessages('feed-a', 2, cycle);
    notifyDutyNewMessages('feed-b', 3, cycle);
    endDutyNotificationPollCycle(cycle);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledWith(
      'Нове повідомлення',
      expect.objectContaining({
        body: 'Відкрийте «Оперативний», щоб переглянути.',
        silent: true,
      }),
    );
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

    const cycle = beginPollCycle();
    notifyNewMessages('feed-a', 2, cycle);
    notifyNewMessages('feed-b', 3, cycle);
    endPollCycle(cycle);

    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(NotificationMock.mock.calls[0]?.[1]?.body).toBe(
      'Відкрийте «Оперативний», щоб переглянути.',
    );
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

  it('recovers an interrupted context from an explicit user gesture', async () => {
    const context = {
      state: 'interrupted' as AudioContextState,
      resume: vi.fn(),
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
      getDutySoundStatus: getSoundStatus,
      resumeDutyNotificationAudioFromUserGesture: resumeAudio,
    } = await import('./notifications');
    const onStatusChange = vi.fn();
    window.addEventListener(statusChangeEvent, onStatusChange);

    await expect(resumeAudio()).resolves.toBe(DutySoundStatus.Ready);
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(getSoundStatus()).toBe(DutySoundStatus.Ready);
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    window.removeEventListener(statusChangeEvent, onStatusChange);
  });

  it('recovers an interrupted context before playing one two-note chime', async () => {
    const createOscillator = vi.fn(() => ({
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      type: 'sine',
      frequency: { setValueAtTime: vi.fn() },
    }));
    const context = {
      currentTime: 0,
      state: 'interrupted' as AudioContextState,
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
      createOscillator,
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
    expect(context.resume).toHaveBeenCalledTimes(1);
    expect(createOscillator).toHaveBeenCalledTimes(2);
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    window.removeEventListener(statusChangeEvent, onStatusChange);
  });

  // Regression: https://github.com/echoua/echo/pull/3331
  it('derives sound readiness from a previously ready context state', async () => {
    const context = {
      state: 'running' as AudioContextState,
      resume: vi.fn(),
    };
    vi.stubGlobal(
      'AudioContext',
      vi.fn(function () {
        return context;
      }),
    );
    vi.resetModules();
    const {
      DutySoundStatus,
      getDutyNotificationBellState: getBellState,
      getDutySoundStatus: getSoundStatus,
      resumeDutyNotificationAudioFromUserGesture: resumeAudio,
    } = await import('./notifications');

    await expect(resumeAudio()).resolves.toBe(DutySoundStatus.Ready);
    expect(getSoundStatus()).toBe(DutySoundStatus.Ready);

    context.state = 'suspended';
    expect(getSoundStatus()).toBe(DutySoundStatus.InteractionRequired);
    expect(getBellState({ soundEnabled: true, browserEnabled: false })).toBe('degraded');

    context.state = 'interrupted' as AudioContextState;
    expect(getSoundStatus()).toBe(DutySoundStatus.InteractionRequired);

    context.state = 'running';
    expect(getSoundStatus()).toBe(DutySoundStatus.Ready);
    expect(getBellState({ soundEnabled: true, browserEnabled: false })).toBe('ready');
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
