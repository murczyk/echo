/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let navigation: typeof import('../navigation-guard');
let cleanup: () => void;
const disposers: (() => void)[] = [];
function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
beforeEach(async () => {
  vi.resetModules();
  window.history.replaceState(
    { unrelated: 7, __echoBrowserBackOverlayIds: ['existing'] },
    '',
    '/source',
  );
  navigation = await import('../navigation-guard');
  cleanup = navigation.installNavigationGuard();
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  cleanup();
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('navigation_cancel_preserves_route_and_overlay_state for programmatic and anchor intents', async () => {
  const decision = deferred();
  disposers.push(navigation.registerNavigationGuard(() => decision.promise));
  const oldState = window.history.state;
  const pending = navigation.requestNavigation('/next');
  expect(window.location.pathname).toBe('/source');
  expect(await navigation.requestNavigation('/ignored')).toBe(false);
  decision.resolve(false);
  expect(await pending).toBe(false);
  expect(window.history.state).toEqual(oldState);
  expect(window.history.state.__echoBrowserBackOverlayIds).toEqual(['existing']);
  const anchor = document.createElement('a');
  anchor.href = '/anchor';
  document.body.appendChild(anchor);
  const event = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
  anchor.dispatchEvent(event);
  await settle();
  expect(event.defaultPrevented).toBe(true);
  expect(window.location.pathname).toBe('/source');
});
it('confirmed_navigation emits one normal popstate and preserves unrelated state keys', async () => {
  disposers.push(navigation.registerNavigationGuard(async () => true));
  const routes: string[] = [];
  const listener = () => routes.push(window.location.pathname);
  window.addEventListener('popstate', listener);
  disposers.push(() => window.removeEventListener('popstate', listener));
  expect(await navigation.requestNavigation('/accepted')).toBe(true);
  expect(routes).toEqual(['/accepted']);
  expect(window.history.state.unrelated).toBe(7);
});
it('fallback restores Back and Forward before asking and replays accepted traversal once', async () => {
  await navigation.requestNavigation('/middle');
  await navigation.requestNavigation('/current');
  const decision = deferred();
  disposers.push(navigation.registerNavigationGuard(() => decision.promise));
  const routes: string[] = [];
  const listener = () => routes.push(window.location.pathname);
  window.addEventListener('popstate', listener);
  disposers.push(() => window.removeEventListener('popstate', listener));
  window.history.back();
  await settle();
  expect(window.location.pathname).toBe('/current');
  expect(routes).toEqual([]);
  decision.resolve(false);
  await settle();
  expect(window.location.pathname).toBe('/current');
  disposers.splice(0, 1).forEach((dispose) => dispose());
  const unregister = navigation.registerNavigationGuard(async () => true);
  disposers.push(unregister);
  expect(await navigation.requestTraversal(-1)).toBe(true);
  await settle();
  expect(window.location.pathname).toBe('/middle');
  expect(routes).toEqual(['/middle']);
  const forward = deferred();
  unregister();
  disposers.push(navigation.registerNavigationGuard(() => forward.promise));
  window.history.forward();
  await settle();
  expect(window.location.pathname).toBe('/middle');
  expect(routes).toEqual(['/middle']);
  forward.resolve(true);
  await settle();
  expect(window.location.pathname).toBe('/current');
  expect(routes).toEqual(['/middle', '/current']);
});
it('same-page query and overlay traversal retain the audio context without a leave decision', async () => {
  let asks = 0;
  disposers.push(
    navigation.registerNavigationGuard(async () => {
      ++asks;
      return false;
    }),
  );
  expect(await navigation.requestNavigation('/source?sync-id=another')).toBe(true);
  window.history.pushState(
    { ...window.history.state, __echoBrowserBackOverlayIds: ['existing', 'dialog'] },
    '',
    window.location.href,
  );
  expect(await navigation.requestTraversal(-1)).toBe(true);
  await settle();
  expect(asks).toBe(0);
  expect(window.location.pathname).toBe('/source');
});
it('mandatory_logout_bypasses_pending_guard and prevents a late accepted intent', async () => {
  const decision = deferred();
  disposers.push(navigation.registerNavigationGuard(() => decision.promise));
  const pending = navigation.requestNavigation('/late');
  let forced = false;
  const listener = () => {
    forced = true;
  };
  window.addEventListener(navigation.FORCED_NAVIGATION_EVENT, listener);
  disposers.push(() => window.removeEventListener(navigation.FORCED_NAVIGATION_EVENT, listener));
  expect(await navigation.requestNavigation('/login', { forced: true, replace: true })).toBe(true);
  expect(forced).toBe(true);
  expect(await pending).toBe(false);
  decision.resolve(true);
  await settle();
  expect(window.location.pathname).toBe('/login');
});
it('ordinary anchors keep their existing handler when no draft guard is registered', () => {
  const anchor = document.createElement('a');
  anchor.href = '/ordinary';
  document.body.appendChild(anchor);
  const existing = vi.fn((event: Event) => event.preventDefault());
  anchor.addEventListener('click', existing);
  anchor.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
  expect(existing).toHaveBeenCalledOnce();
});
it('failed native traversal never reports an accepted transition', async () => {
  cleanup();
  vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const api = new EventTarget() as EventTarget & Record<string, unknown>;
  api.currentEntry = { index: 4, key: 'current', url: window.location.href };
  api.entries = () => [
    { index: 3, key: 'previous', url: new URL('/previous', window.location.href).href },
  ];
  vi.stubGlobal('navigation', api);
  cleanup = navigation.installNavigationGuard();
  disposers.push(navigation.registerNavigationGuard(async () => true));
  vi.useFakeTimers();
  const traversal = navigation.requestTraversal(-1);
  await vi.advanceTimersByTimeAsync(3000);
  expect(await traversal).toBe(false);
  vi.useRealTimers();
});
it('cancelable native navigation waits for a decision before replaying a keyed traversal', async () => {
  cleanup();
  const api = new EventTarget() as EventTarget & Record<string, unknown>;
  api.currentEntry = { index: 4, key: 'current', url: window.location.href };
  const traverse = vi.fn(() => ({ finished: Promise.reject(new Error('entry removed')) }));
  api.traverseTo = traverse;
  vi.stubGlobal('navigation', api);
  cleanup = navigation.installNavigationGuard();
  const decision = deferred();
  disposers.push(navigation.registerNavigationGuard(() => decision.promise));
  const attempt = new Event('navigate', { cancelable: true });
  Object.assign(attempt, {
    destination: { url: new URL('/native', window.location.href).href, key: 'previous' },
    navigationType: 'traverse',
    canIntercept: true,
  });
  api.dispatchEvent(attempt);
  expect(attempt.defaultPrevented).toBe(true);
  expect(traverse).not.toHaveBeenCalled();
  expect(window.location.pathname).toBe('/source');
  decision.resolve(true);
  await settle();
  expect(traverse).toHaveBeenCalledOnce();
  expect(traverse).toHaveBeenCalledWith('previous');
  expect(window.location.pathname).toBe('/source');
});
