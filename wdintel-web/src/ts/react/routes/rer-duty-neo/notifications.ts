import { isNullOrUndefined, isPresent } from '../../utils/misc';

export type DutyNotificationSettings = {
  soundEnabled: boolean;
  browserEnabled: boolean;
};

export enum DutySoundStatus {
  Ready = 'ready',
  InteractionRequired = 'interaction-required',
  Blocked = 'blocked',
  Unsupported = 'unsupported',
}

export enum DutyBrowserNotificationStatus {
  NotRequested = 'not-requested',
  Granted = 'granted',
  Denied = 'denied',
  Unsupported = 'unsupported',
  RuntimeFailure = 'runtime-failure',
}

export type DutyStorageResult = { ok: true } | { ok: false; error: string };
export type DutyNotificationBellState = 'off' | 'ready' | 'degraded' | 'unsupported';

export const DUTY_NOTIFICATION_STATUS_CHANGE_EVENT = 'duty-notification-status-change';

const DUTY_NOTIFICATION_SETTINGS_STORAGE_KEY = 'rer-duty-neo-notifications';

function isLegacyGlobalNotificationShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const keys = Object.keys(parsed as object);
  if (keys.length === 0) return false;
  return keys.every((k) => k === 'soundEnabled' || k === 'browserEnabled');
}

function normalizeFeedSettingsRecord(parsed: unknown): Record<string, DutyNotificationSettings> {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, DutyNotificationSettings> = {};
  for (const [feedId, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (feedId === 'soundEnabled' || feedId === 'browserEnabled') continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const row = v as Record<string, unknown>;
    out[feedId] = {
      soundEnabled: Boolean(row.soundEnabled),
      browserEnabled: Boolean(row.browserEnabled),
    };
  }
  return out;
}

function readDutyNotificationSettingsByFeed(): Record<string, DutyNotificationSettings> {
  if (typeof window === 'undefined') return {};
  try {
    const mainRaw = window.localStorage.getItem(DUTY_NOTIFICATION_SETTINGS_STORAGE_KEY);
    if (!mainRaw) return {};
    const parsed = JSON.parse(mainRaw) as unknown;
    if (isLegacyGlobalNotificationShape(parsed)) {
      window.localStorage.setItem(DUTY_NOTIFICATION_SETTINGS_STORAGE_KEY, JSON.stringify({}));
      return {};
    }
    return normalizeFeedSettingsRecord(parsed);
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

export function setStoredDutyNotificationSettingsForFeed(
  feedId: string,
  value: DutyNotificationSettings,
): DutyStorageResult {
  if (typeof window === 'undefined') return { ok: true };
  try {
    const next = { ...readDutyNotificationSettingsByFeed(), [feedId]: value };
    window.localStorage.setItem(DUTY_NOTIFICATION_SETTINGS_STORAGE_KEY, JSON.stringify(next));
    return { ok: true };
  } catch (error) {
    console.warn('Failed to save per-feed notification settings', error);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

let browserNotificationRuntimeFailure: string | null = null;
const lastSuccessfulDutyCountCheckByFeedId = new Map<string, Date>();

export function recordLastSuccessfulDutyCountCheck(feedId: string): Date {
  const at = new Date();
  lastSuccessfulDutyCountCheckByFeedId.set(feedId, at);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('duty-notification-poll-success', { detail: { feedId, at } }),
    );
  }
  return at;
}

export function getLastSuccessfulDutyCountCheck(feedId: string): Date | null {
  return lastSuccessfulDutyCountCheckByFeedId.get(feedId) ?? null;
}

export function removeLastSuccessfulDutyCountCheck(feedId: string): void {
  lastSuccessfulDutyCountCheckByFeedId.delete(feedId);
}

export function getBrowserNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export function getBrowserNotificationStatus(): DutyBrowserNotificationStatus {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return DutyBrowserNotificationStatus.Unsupported;
  }
  if (Notification.permission === 'denied') return DutyBrowserNotificationStatus.Denied;
  if (Notification.permission === 'default') return DutyBrowserNotificationStatus.NotRequested;
  return browserNotificationRuntimeFailure !== null
    ? DutyBrowserNotificationStatus.RuntimeFailure
    : DutyBrowserNotificationStatus.Granted;
}

export function getDutyNotificationBellState(
  settings: DutyNotificationSettings,
): DutyNotificationBellState {
  if (!settings.soundEnabled && !settings.browserEnabled) return 'off';
  const sound = settings.soundEnabled ? getDutySoundStatus() : null;
  const browser = settings.browserEnabled ? getBrowserNotificationStatus() : null;
  const supported = [
    sound !== DutySoundStatus.Unsupported,
    browser !== DutyBrowserNotificationStatus.Unsupported,
  ].filter((value, index) => [settings.soundEnabled, settings.browserEnabled][index]);
  if (!supported.some(Boolean)) return 'unsupported';
  const ready =
    (!settings.soundEnabled || sound === DutySoundStatus.Ready) &&
    (!settings.browserEnabled || browser === DutyBrowserNotificationStatus.Granted);
  return ready ? 'ready' : 'degraded';
}

export async function requestBrowserNotificationPermission(): Promise<
  NotificationPermission | 'unsupported'
> {
  if (typeof window === 'undefined') return 'unsupported';
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') browserNotificationRuntimeFailure = null;
    return permission;
  } catch (error) {
    browserNotificationRuntimeFailure = error instanceof Error ? error.message : String(error);
    return 'denied';
  }
}

export function showBrowserNotification(title: string, options?: NotificationOptions): void {
  if (typeof window === 'undefined') return;
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  const previousStatus = getBrowserNotificationStatus();
  try {
    const notification = new Notification(title, options);
    notification.addEventListener('click', () => window.focus());
    browserNotificationRuntimeFailure = null;
  } catch (error) {
    browserNotificationRuntimeFailure = error instanceof Error ? error.message : String(error);
  }
  if (previousStatus !== getBrowserNotificationStatus()) {
    window.dispatchEvent(new Event(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT));
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
let dutySoundStatus = DutySoundStatus.InteractionRequired;

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
  if (!Ctor) {
    dutySoundStatus = DutySoundStatus.Unsupported;
    return null;
  }
  if (!dutyNotificationAudioContext || dutyNotificationAudioContext.state === 'closed') {
    dutyNotificationAudioContext = new Ctor();
  }
  return dutyNotificationAudioContext;
}

export function getDutySoundStatus(): DutySoundStatus {
  if (!getDutyAudioContextConstructor()) return DutySoundStatus.Unsupported;
  return dutyNotificationAudioContext?.state === 'running'
    ? DutySoundStatus.Ready
    : dutySoundStatus;
}

/**
 * Browsers start AudioContext suspended without a user gesture; polling cannot unlock it.
 * Call from a click/key handler (e.g. toggling sound on in settings) so later timer-driven beeps work.
 */
export async function resumeDutyNotificationAudioFromUserGesture(): Promise<DutySoundStatus> {
  const previousStatus = getDutySoundStatus();
  const ctx = getOrCreateDutyNotificationAudioContext();
  if (!ctx) return DutySoundStatus.Unsupported;
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    dutySoundStatus =
      ctx.state === 'running' ? DutySoundStatus.Ready : DutySoundStatus.InteractionRequired;
  } catch {
    dutySoundStatus = DutySoundStatus.Blocked;
  }
  if (previousStatus !== getDutySoundStatus() && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT));
  }
  return dutySoundStatus;
}

/** Attach listeners until the user interacts once; cleanup on unmount. */
export function attachDutyNotificationAudioPrimingListeners(): () => void {
  if (typeof window === 'undefined') return () => {};
  const onGesture = () => {
    void resumeDutyNotificationAudioFromUserGesture();
  };
  window.addEventListener('pointerdown', onGesture);
  window.addEventListener('keydown', onGesture);
  const onReturn = () => {
    if (document.visibilityState === 'visible') void resumeDutyNotificationAudioFromUserGesture();
  };
  window.addEventListener('focus', onReturn);
  document.addEventListener('visibilitychange', onReturn);
  return () => {
    window.removeEventListener('pointerdown', onGesture);
    window.removeEventListener('keydown', onGesture);
    window.removeEventListener('focus', onReturn);
    document.removeEventListener('visibilitychange', onReturn);
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
  scheduleSoftSineTone(
    ctx,
    master,
    t2,
    d2,
    DUTY_NOTIF_CHIME_SECOND_HZ,
    DUTY_NOTIF_CHIME_PEAK_SECOND,
  );
}

export async function playNotificationSound(): Promise<DutySoundStatus> {
  if (typeof window === 'undefined') return DutySoundStatus.Unsupported;
  try {
    const ctx = getOrCreateDutyNotificationAudioContext();
    if (!ctx) return DutySoundStatus.Unsupported;
    const run = () => {
      if (ctx.state !== 'running') return;
      try {
        playDutyNotificationChimeOnContext(ctx);
        dutySoundStatus = DutySoundStatus.Ready;
      } catch {
        dutySoundStatus = DutySoundStatus.Blocked;
      }
    };
    if (ctx.state === 'running') {
      run();
    } else {
      await resumeDutyNotificationAudioFromUserGesture();
      run();
    }
  } catch {
    dutySoundStatus = DutySoundStatus.Blocked;
  }
  return dutySoundStatus;
}

export function testBrowserNotification(): DutyBrowserNotificationStatus {
  if (typeof window === 'undefined' || !('Notification' in window))
    return DutyBrowserNotificationStatus.Unsupported;
  if (Notification.permission === 'denied') return DutyBrowserNotificationStatus.Denied;
  if (Notification.permission !== 'granted') return DutyBrowserNotificationStatus.NotRequested;
  try {
    new Notification('Перевірка сповіщення', {
      body: 'Браузер прийняв запит. Доставку визначає система.',
      silent: true,
    });
    browserNotificationRuntimeFailure = null;
    return DutyBrowserNotificationStatus.Granted;
  } catch (error) {
    browserNotificationRuntimeFailure = error instanceof Error ? error.message : String(error);
    return DutyBrowserNotificationStatus.RuntimeFailure;
  }
}

type PendingDutyAlert = { feedId: string; totalNew: number };
let dutyPollAlerts: PendingDutyAlert[] | null = null;

function deliverDutyAlerts(alerts: PendingDutyAlert[]): void {
  const enabled = alerts.filter(({ feedId }) => {
    const settings = getStoredDutyNotificationSettingsForFeed(feedId);
    return settings.soundEnabled || settings.browserEnabled;
  });
  if (enabled.some(({ feedId }) => getStoredDutyNotificationSettingsForFeed(feedId).soundEnabled)) {
    void playNotificationSound();
  }
  const browserEnabled = enabled.filter(
    ({ feedId }) => getStoredDutyNotificationSettingsForFeed(feedId).browserEnabled,
  );
  if (browserEnabled.length > 0) {
    const total = browserEnabled.reduce((sum, alert) => sum + alert.totalNew, 0);
    showBrowserNotification('Нові повідомлення в оперативному', {
      body: `Нових повідомлень: ${total}. Стрічок: ${browserEnabled.length}.`,
      silent: true,
    });
  }
}

/** One explicit poll owns aggregation; overlapping triggers join the poll coordinator. */
export function beginDutyNotificationPollCycle(): void {
  dutyPollAlerts = [];
}

export function endDutyNotificationPollCycle(): void {
  const alerts = dutyPollAlerts;
  dutyPollAlerts = null;
  if (alerts) deliverDutyAlerts(alerts);
}

export function publishDutyNotificationPollSuccess(feedId: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('duty-notification-poll-success', { detail: { feedId } }));
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
    dutyNeoDocumentTitleCount > 0
      ? `(${dutyNeoDocumentTitleCount}) ${dutyNeoDocumentTitleBase}`
      : dutyNeoDocumentTitleBase;
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
  const alert = { feedId, totalNew };
  if (dutyPollAlerts) dutyPollAlerts.push(alert);
  else deliverDutyAlerts([alert]);
}
