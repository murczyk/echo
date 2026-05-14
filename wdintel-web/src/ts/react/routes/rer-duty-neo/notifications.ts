import { isNullOrUndefined, isPresent } from '../../utils/misc';

export type DutyNotificationSettings = {
  soundEnabled: boolean;
  browserEnabled: boolean;
};

const DUTY_NOTIFICATION_SETTINGS_BY_FEED_KEY = 'rer-duty-neo-notifications-by-feed';

function readDutyNotificationSettingsByFeed(): Record<string, DutyNotificationSettings> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DUTY_NOTIFICATION_SETTINGS_BY_FEED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<DutyNotificationSettings>> | null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, DutyNotificationSettings> = {};
    for (const [feedId, v] of Object.entries(parsed)) {
      out[feedId] = {
        soundEnabled: Boolean(v?.soundEnabled),
        browserEnabled: Boolean(v?.browserEnabled),
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function getStoredDutyNotificationSettingsForFeed(feedId: string): DutyNotificationSettings {
  const byFeed = readDutyNotificationSettingsByFeed();
  const forFeed = byFeed[feedId];
  if (forFeed) return forFeed;
  return { soundEnabled: false, browserEnabled: false };
}

export function setStoredDutyNotificationSettingsForFeed(feedId: string, value: DutyNotificationSettings): void {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readDutyNotificationSettingsByFeed(), [feedId]: value };
    window.localStorage.setItem(DUTY_NOTIFICATION_SETTINGS_BY_FEED_KEY, JSON.stringify(next));
  } catch (error) {
    console.warn('Failed to save per-feed notification settings', error);
  }
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

/**
 * In-tab duty alert — **duplet** (two notes only): D5 → A5, fifth, soft sine envelopes.
 * Slightly below E5 → B5; peaks tuned for laptop speakers (still below typical clipping).
 */
const DUTY_NOTIF_CHIME_MASTER_GAIN = 1;
const DUTY_NOTIF_CHIME_FIRST_HZ = 587.33; // D5
const DUTY_NOTIF_CHIME_SECOND_HZ = 880.0; // A5
const DUTY_NOTIF_CHIME_FIRST_MS = 168;
const DUTY_NOTIF_CHIME_GAP_MS = 102;
const DUTY_NOTIF_CHIME_SECOND_MS = 205;
const DUTY_NOTIF_CHIME_ATTACK_S = 0.028;
const DUTY_NOTIF_CHIME_PEAK_FIRST = 0.22;
const DUTY_NOTIF_CHIME_PEAK_SECOND = 0.17;

let dutyNotificationAudioContext: AudioContext | null = null;

function getDutyAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  return (
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ||
    null
  );
}

function getOrCreateDutyNotificationAudioContext(): AudioContext | null {
  const Ctor = getDutyAudioContextConstructor();
  if (!Ctor) return null;
  if (!dutyNotificationAudioContext || dutyNotificationAudioContext.state === 'closed') {
    dutyNotificationAudioContext = new Ctor();
  }
  return dutyNotificationAudioContext;
}

/**
 * Browsers start AudioContext suspended without a user gesture; polling cannot unlock it.
 * Call from a click/key handler (e.g. toggling sound on in settings) so later timer-driven beeps work.
 */
export function resumeDutyNotificationAudioFromUserGesture(): void {
  const ctx = getOrCreateDutyNotificationAudioContext();
  if (ctx?.state === 'suspended') {
    void ctx.resume();
  }
}

/** Attach listeners until the user interacts once; cleanup on unmount. */
export function attachDutyNotificationAudioPrimingListeners(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onGesture = () => {
    resumeDutyNotificationAudioFromUserGesture();
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
  };
  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('keydown', onGesture);
  return () => {
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
  };
}

function scheduleSoftSineTone(
  ctx: AudioContext,
  dest: AudioNode,
  startTime: number,
  durationSec: number,
  frequencyHz: number,
  peakGain: number,
): void {
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(frequencyHz, startTime);
  const g = ctx.createGain();
  const end = startTime + durationSec;
  g.gain.setValueAtTime(0, startTime);
  g.gain.linearRampToValueAtTime(peakGain, startTime + DUTY_NOTIF_CHIME_ATTACK_S);
  g.gain.exponentialRampToValueAtTime(0.0009, end);
  osc.connect(g);
  g.connect(dest);
  osc.start(startTime);
  osc.stop(end + 0.05);
}

function playDutyNotificationChimeOnContext(ctx: AudioContext): void {
  const t0 = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.value = DUTY_NOTIF_CHIME_MASTER_GAIN;
  master.connect(ctx.destination);
  const d1 = DUTY_NOTIF_CHIME_FIRST_MS / 1000;
  const d2 = DUTY_NOTIF_CHIME_SECOND_MS / 1000;
  const t2 = t0 + DUTY_NOTIF_CHIME_GAP_MS / 1000;
  scheduleSoftSineTone(ctx, master, t0, d1, DUTY_NOTIF_CHIME_FIRST_HZ, DUTY_NOTIF_CHIME_PEAK_FIRST);
  scheduleSoftSineTone(ctx, master, t2, d2, DUTY_NOTIF_CHIME_SECOND_HZ, DUTY_NOTIF_CHIME_PEAK_SECOND);
}

export function playNotificationSound(): void {
  if (typeof window === 'undefined') return;
  try {
    const ctx = getOrCreateDutyNotificationAudioContext();
    if (!ctx) return;
    const run = () => {
      if (ctx.state !== 'running') return;
      try {
        playDutyNotificationChimeOnContext(ctx);
      } catch {
        // ignore
      }
    };
    if (ctx.state === 'running') {
      run();
    } else {
      void ctx.resume().then(run);
    }
  } catch {
    // ignore
  }
}

/** Strip a leading `(N)` / legacy `(+N)` count prefix from the tab title. */
const DUTY_DOCUMENT_TITLE_COUNT_PREFIX = /^\(\+?\d+\)\s*/;

let dutyNeoDocumentTitleBase: string | null = null;
let dutyNeoDocumentTitleCount = 0;
let dutyNeoDocumentTitleTracking = false;

function stripDutyNeoDocumentTitleCountPrefix(title: string): string {
  return title.replace(DUTY_DOCUMENT_TITLE_COUNT_PREFIX, '').trimStart();
}

function applyDutyNeoDocumentTitle(): void {
  if (typeof document === 'undefined' || isNullOrUndefined(dutyNeoDocumentTitleBase)) return;
  document.title =
    dutyNeoDocumentTitleCount > 0 ? `(${dutyNeoDocumentTitleCount}) ${dutyNeoDocumentTitleBase}` : dutyNeoDocumentTitleBase;
}

/**
 * While the duty page is mounted: allows {@link setDutyNeoDocumentTitleUnreadCount} to prefix `document.title` with `(N)`.
 * Cleanup restores the captured base title.
 */
export function startDutyNeoDocumentTitleTracking(): () => void {
  if (typeof document === 'undefined') return () => {};
  dutyNeoDocumentTitleBase = stripDutyNeoDocumentTitleCountPrefix(document.title);
  dutyNeoDocumentTitleCount = 0;
  dutyNeoDocumentTitleTracking = true;
  applyDutyNeoDocumentTitle();

  return () => {
    dutyNeoDocumentTitleTracking = false;
    const base = dutyNeoDocumentTitleBase;
    dutyNeoDocumentTitleBase = null;
    dutyNeoDocumentTitleCount = 0;
    if (isPresent(base)) {
      document.title = base;
    }
  };
}

export function setDutyNeoDocumentTitleUnreadCount(totalUnread: number): void {
  if (!dutyNeoDocumentTitleTracking || isNullOrUndefined(dutyNeoDocumentTitleBase)) return;
  dutyNeoDocumentTitleCount = Math.max(0, Math.floor(totalUnread));
  applyDutyNeoDocumentTitle();
}

export function notifyDutyNewMessages(feedId: string, totalNew: number): void {
  if (totalNew <= 0) return;
  const settings = getStoredDutyNotificationSettingsForFeed(feedId);
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
