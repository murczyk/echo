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
  if (browserNotificationRuntimeFailure !== null)
    return DutyBrowserNotificationStatus.RuntimeFailure;
  if (Notification.permission === 'default') return DutyBrowserNotificationStatus.NotRequested;
  return DutyBrowserNotificationStatus.Granted;
}

function publishBrowserNotificationStatusTransition(
  previousStatus: DutyBrowserNotificationStatus,
): void {
  if (typeof window === 'undefined') return;
  if (previousStatus !== getBrowserNotificationStatus()) {
    window.dispatchEvent(new Event(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT));
  }
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
  const permission = Notification.permission;
  if (permission !== 'default') {
    if (permission === 'granted' && browserNotificationRuntimeFailure !== null) {
      const previousStatus = getBrowserNotificationStatus();
      browserNotificationRuntimeFailure = null;
      publishBrowserNotificationStatusTransition(previousStatus);
    }
    return permission;
  }
  const previousStatus = getBrowserNotificationStatus();
  try {
    const permission = await Notification.requestPermission();
    browserNotificationRuntimeFailure = null;
    publishBrowserNotificationStatusTransition(previousStatus);
    return permission;
  } catch (error) {
    browserNotificationRuntimeFailure = error instanceof Error ? error.message : String(error);
    publishBrowserNotificationStatusTransition(previousStatus);
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
  publishBrowserNotificationStatusTransition(previousStatus);
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
let dutyPlaybackFailed = false;

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
  if (dutyPlaybackFailed) return DutySoundStatus.Blocked;

  const contextState = dutyNotificationAudioContext?.state;
  if (contextState === 'running') return DutySoundStatus.Ready;

  if (contextState && dutySoundStatus === DutySoundStatus.Ready) {
    return DutySoundStatus.InteractionRequired;
  }

  return dutySoundStatus;
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
    if (ctx.state !== 'running' && ctx.state !== 'closed') await ctx.resume();
    dutySoundStatus =
      ctx.state === 'running' ? DutySoundStatus.Ready : DutySoundStatus.InteractionRequired;
  } catch {
    dutySoundStatus = DutySoundStatus.Blocked;
  }
  if (previousStatus !== getDutySoundStatus() && typeof window !== 'undefined') {
    window.dispatchEvent(new Event(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT));
  }
  return getDutySoundStatus();
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
  let playbackStatusBaseline = getDutySoundStatus();
  try {
    const ctx = getOrCreateDutyNotificationAudioContext();
    if (!ctx) return DutySoundStatus.Unsupported;
    const run = () => {
      if (ctx.state !== 'running') return;
      try {
        playDutyNotificationChimeOnContext(ctx);
        dutyPlaybackFailed = false;
        dutySoundStatus = DutySoundStatus.Ready;
      } catch {
        dutyPlaybackFailed = true;
        dutySoundStatus = DutySoundStatus.Blocked;
      }
    };
    if (ctx.state === 'running') {
      run();
    } else {
      await resumeDutyNotificationAudioFromUserGesture();
      playbackStatusBaseline = getDutySoundStatus();
      run();
    }
  } catch {
    dutyPlaybackFailed = true;
    dutySoundStatus = DutySoundStatus.Blocked;
  }
  const finalStatus = getDutySoundStatus();
  if (playbackStatusBaseline !== finalStatus) {
    window.dispatchEvent(new Event(DUTY_NOTIFICATION_STATUS_CHANGE_EVENT));
  }
  return finalStatus;
}

export function testBrowserNotification(): DutyBrowserNotificationStatus {
  if (typeof window === 'undefined' || !('Notification' in window))
    return DutyBrowserNotificationStatus.Unsupported;
  if (Notification.permission === 'denied') return DutyBrowserNotificationStatus.Denied;
  if (Notification.permission !== 'granted') return DutyBrowserNotificationStatus.NotRequested;
  const previousStatus = getBrowserNotificationStatus();
  try {
    new Notification('Перевірка сповіщення', {
      body: 'Браузер прийняв запит. Доставку визначає система.',
      silent: true,
    });
    browserNotificationRuntimeFailure = null;
    publishBrowserNotificationStatusTransition(previousStatus);
    return getBrowserNotificationStatus();
  } catch (error) {
    browserNotificationRuntimeFailure = error instanceof Error ? error.message : String(error);
    publishBrowserNotificationStatusTransition(previousStatus);
    return getBrowserNotificationStatus();
  }
}

export type DutyNotificationPreview = {
  messageId: number;
  orderTimestamp: number | null;
  title: string;
  body: string;
};
export enum DutyNotificationPreviewResultKind {
  Ready = 'ready',
  Unavailable = 'unavailable',
  Stale = 'stale',
}
export type DutyNotificationPreviewResult =
  | { kind: DutyNotificationPreviewResultKind.Ready; preview: DutyNotificationPreview }
  | { kind: DutyNotificationPreviewResultKind.Unavailable }
  | { kind: DutyNotificationPreviewResultKind.Stale };
type PendingDutyAlert = {
  feedId: string;
  totalNew: number;
  loadPreview?: () => Promise<DutyNotificationPreviewResult>;
};
declare const dutyNotificationPollCycleBrand: unique symbol;
export type DutyNotificationPollCycle = { readonly [dutyNotificationPollCycleBrand]: true };
type DutyNotificationPollCycleState = {
  alerts: PendingDutyAlert[];
  status: 'active' | 'ended' | 'cancelled';
};
const dutyNotificationPollCycleStates = new WeakMap<
  DutyNotificationPollCycle,
  DutyNotificationPollCycleState
>();
const dutyNotificationPreviewLoaders = new WeakMap<
  DutyNotificationPollCycle,
  Map<string, () => Promise<DutyNotificationPreviewResult>>
>();

export function registerDutyNotificationPreview(
  cycle: DutyNotificationPollCycle,
  feedId: string,
  loadPreview: () => Promise<DutyNotificationPreviewResult>,
): void {
  const loaders = dutyNotificationPreviewLoaders.get(cycle) ?? new Map();
  loaders.set(feedId, loadPreview);
  dutyNotificationPreviewLoaders.set(cycle, loaders);
}

function deliverDutyAlerts(alerts: PendingDutyAlert[], cycle?: DutyNotificationPollCycle): void {
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
  if (browserEnabled.length === 0) return;
  if (!cycle || !browserEnabled.some((alert) => alert.loadPreview)) {
    showBrowserNotification('Нове повідомлення', {
      body: 'Відкрийте «Оперативний», щоб переглянути.',
      silent: true,
      tag: `duty-cycle-${Date.now()}`,
    });
    return;
  }
  void Promise.all(
    browserEnabled.map(
      (alert) =>
        alert
          .loadPreview?.()
          .catch(() => ({ kind: DutyNotificationPreviewResultKind.Unavailable })) ??
        Promise.resolve({ kind: DutyNotificationPreviewResultKind.Unavailable }),
    ),
  ).then((results) => {
    const state = dutyNotificationPollCycleStates.get(cycle);
    if (!state || state.status === 'cancelled') return;
    const eligible = results.filter(
      (result, index) =>
        getStoredDutyNotificationSettingsForFeed(browserEnabled[index]!.feedId).browserEnabled &&
        result.kind !== DutyNotificationPreviewResultKind.Stale,
    );
    if (eligible.length === 0) return;
    const unique = new Map<number, DutyNotificationPreview>();
    eligible
      .filter(
        (
          result,
        ): result is Extract<
          DutyNotificationPreviewResult,
          { kind: DutyNotificationPreviewResultKind.Ready }
        > => result.kind === DutyNotificationPreviewResultKind.Ready,
      )
      .forEach(({ preview }) => {
        unique.set(preview.messageId, preview);
      });
    const newest = [...unique.values()].sort(
      (a, b) => (b.orderTimestamp ?? 0) - (a.orderTimestamp ?? 0) || b.messageId - a.messageId,
    )[0];
    if (
      !newest &&
      !eligible.some((result) => result.kind === DutyNotificationPreviewResultKind.Unavailable)
    )
      return;
    showBrowserNotification(newest?.title ?? 'Нове повідомлення', {
      body: newest?.body ?? 'Відкрийте «Оперативний», щоб переглянути.',
      silent: true,
      tag: newest ? `duty-message-${newest.messageId}` : `duty-cycle-${Date.now()}`,
    });
  });
}

/** One explicit poll owns aggregation; overlapping triggers retain independent handles. */
export function beginDutyNotificationPollCycle(): DutyNotificationPollCycle {
  const cycle = {} as DutyNotificationPollCycle;
  dutyNotificationPollCycleStates.set(cycle, { alerts: [], status: 'active' });
  return cycle;
}

export function endDutyNotificationPollCycle(cycle: DutyNotificationPollCycle): void {
  const state = dutyNotificationPollCycleStates.get(cycle);
  if (!state || state.status !== 'active') return;
  state.status = 'ended';
  deliverDutyAlerts(state.alerts, cycle);
  state.alerts = [];
}

export function cancelDutyNotificationPollCycle(cycle: DutyNotificationPollCycle): void {
  const state = dutyNotificationPollCycleStates.get(cycle);
  if (!state || state.status === 'cancelled') return;
  state.status = 'cancelled';
  state.alerts = [];
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

export function notifyDutyNewMessages(
  feedId: string,
  totalNew: number,
  cycle?: DutyNotificationPollCycle,
): void {
  if (totalNew <= 0) return;
  const alert = {
    feedId,
    totalNew,
    loadPreview: cycle ? dutyNotificationPreviewLoaders.get(cycle)?.get(feedId) : undefined,
  };
  if (!cycle) return deliverDutyAlerts([alert]);
  const state = dutyNotificationPollCycleStates.get(cycle);
  if (!state || state.status === 'cancelled') return;
  if (state.status === 'active') {
    state.alerts.push(alert);
    return;
  }
  deliverDutyAlerts([alert]);
}
