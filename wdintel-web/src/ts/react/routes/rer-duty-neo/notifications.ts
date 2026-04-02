export type DutyNotificationSettings = {
  soundEnabled: boolean;
  browserEnabled: boolean;
};

const DUTY_NOTIFICATION_SETTINGS_KEY = 'rer-duty-neo-notifications';

export function getStoredDutyNotificationSettings(): DutyNotificationSettings {
  if (typeof window === 'undefined') {
    return { soundEnabled: false, browserEnabled: false };
  }
  try {
    const raw = window.localStorage.getItem(DUTY_NOTIFICATION_SETTINGS_KEY);
    if (!raw) return { soundEnabled: false, browserEnabled: false };
    const parsed = JSON.parse(raw) as Partial<DutyNotificationSettings> | null;
    return {
      soundEnabled: Boolean(parsed?.soundEnabled),
      browserEnabled: Boolean(parsed?.browserEnabled),
    };
  } catch {
    return { soundEnabled: false, browserEnabled: false };
  }
}

export function setStoredDutyNotificationSettings(value: DutyNotificationSettings): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DUTY_NOTIFICATION_SETTINGS_KEY, JSON.stringify(value));
}

export function getBrowserNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}

export function showBrowserNotification(title: string, options?: NotificationOptions): void {
  if (typeof window === 'undefined') return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const notification = new Notification(title, options);
    notification.addEventListener('click', () => window.focus());
  } catch {
    // ignore
  }
}

export function playNotificationSound(): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioContext = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof window.AudioContext }).webkitAudioContext;
    if (!AudioContext) return;
    const ctx = new AudioContext();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.value = 0.06;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.25);
    oscillator.onended = () => {
      void ctx.close();
    };
  } catch {
    // ignore
  }
}

export function notifyDutyNewMessages(totalNew: number): void {
  if (totalNew <= 0) return;
  const settings = getStoredDutyNotificationSettings();
  if (settings.soundEnabled) {
    playNotificationSound();
  }
  if (settings.browserEnabled) {
    showBrowserNotification('Нові повідомлення в оперативному', {
      body: `Нових повідомлень: ${totalNew}`,
      silent: true,
    });
  }
}
