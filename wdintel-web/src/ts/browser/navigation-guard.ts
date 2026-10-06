import { getNavigationApi, type NavigationNavigateEvent } from './navigation-api';

export const FORCED_NAVIGATION_EVENT = 'echo:forced-navigation';
const HISTORY_INDEX = '__echoNavigationIndex';
type Position = { index: number; url: string; state: unknown };
type Pending = { cancel: () => void };
let installed = false;
let bypass = 0;
let position: Position;
let pending: Pending | null = null;
let recovering: { source: Position; target: Position; phase: 'restore' | 'ask' } | null = null;
let allowedTraversal: {
  resolve: (value: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;
let originalGo: History['go'];
const guards = new Set<() => Promise<boolean>>();
const knownEntries = new Map<number, string>();

function stateObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}
function indexOf(value: unknown) {
  const index = stateObject(value)[HISTORY_INDEX];
  return typeof index === 'number' && Number.isSafeInteger(index) ? index : null;
}
function snapshot(index: number): Position {
  return { index, state: window.history.state, url: window.location.href };
}
function sameContext(url: string) {
  return new URL(url, window.location.href).pathname === new URL(position.url).pathname;
}
function remember(index: number) {
  position = snapshot(index);
  knownEntries.set(index, position.url);
}
function finishTraversal(value: boolean) {
  const traversal = allowedTraversal;
  allowedTraversal = null;
  if (traversal) {
    clearTimeout(traversal.timeout);
    traversal.resolve(value);
  }
}

function runIntent(action: () => void | Promise<unknown>, destination?: string): Promise<boolean> {
  if (pending) return Promise.resolve(false);
  if (guards.size === 0 || (destination && sameContext(destination))) {
    const result = action();
    return Promise.resolve(result).then((value) => value !== false);
  }
  let finish!: (value: boolean) => void;
  const result = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const intent = { cancel: () => finish(false) };
  pending = intent;
  void (async () => {
    try {
      for (const guard of [...guards]) {
        if (!(await guard()) || pending !== intent) {
          finish(false);
          return;
        }
      }
      if (pending !== intent) return;
      const value = await action();
      finish(value !== false);
    } catch {
      finish(false);
    } finally {
      if (pending === intent) pending = null;
    }
  })();
  return result;
}

export function prepareForcedNavigation() {
  pending?.cancel();
  pending = null;
  guards.clear();
  recovering = null;
  finishTraversal(false);
  window.dispatchEvent(new Event(FORCED_NAVIGATION_EVENT));
}

function commitNavigation(url: string, replace = false) {
  const data = stateObject(window.history.state);
  if (!sameContext(url)) delete data.__echoBrowserBackOverlayIds;
  if (replace) window.history.replaceState(data, '', url);
  else window.history.pushState(data, '', url);
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
}

export function requestNavigation(
  url: string,
  options?: { replace?: boolean; forced?: boolean },
): Promise<boolean> {
  installNavigationGuard();
  const destination = new URL(url, window.location.href);
  if (destination.origin !== window.location.origin) {
    if (options?.forced) prepareForcedNavigation();
    if (options?.replace) window.location.replace(destination.href);
    else window.location.assign(destination.href);
    return Promise.resolve(true);
  }
  if (options?.forced) {
    prepareForcedNavigation();
    commitNavigation(destination.href, options.replace);
    return Promise.resolve(true);
  }
  return runIntent(() => commitNavigation(destination.href, options?.replace), destination.href);
}

function issueTraversal(action: () => void) {
  return new Promise<boolean>((resolve) => {
    allowedTraversal = { resolve, timeout: setTimeout(() => finishTraversal(false), 3000) };
    action();
  });
}
export function requestTraversal(delta: number): Promise<boolean> {
  installNavigationGuard();
  if (!Number.isSafeInteger(delta) || delta === 0) return Promise.resolve(false);
  const api = getNavigationApi();
  const entry = api?.currentEntry
    ? api.entries?.().find((entry) => entry.index === api.currentEntry!.index + delta)
    : undefined;
  const destination = entry?.url ?? knownEntries.get(position.index + delta);
  const traverse = () => {
    if (delta === -1) window.history.back();
    else window.history.go(delta);
  };
  if (!destination) {
    if (guards.size > 0 || pending) return Promise.resolve(false);
    traverse();
    return Promise.resolve(true);
  }
  if (!pending && (guards.size === 0 || sameContext(destination))) {
    traverse();
    return Promise.resolve(true);
  }
  return runIntent(() => issueTraversal(traverse), destination);
}

function handleNativeNavigation(event: Event) {
  const navigation = event as Event & NavigationNavigateEvent;
  if (
    bypass ||
    allowedTraversal ||
    event.defaultPrevented ||
    !event.cancelable ||
    navigation.canIntercept === false ||
    navigation.downloadRequest ||
    navigation.formData ||
    navigation.navigationType === 'reload' ||
    !navigation.destination?.url
  )
    return;
  const url = new URL(navigation.destination.url, window.location.href);
  if (url.origin !== window.location.origin || sameContext(url.href) || guards.size === 0) return;
  const api = getNavigationApi();
  event.preventDefault();
  if (navigation.navigationType === 'traverse' && api?.traverseTo && navigation.destination.key) {
    const key = navigation.destination.key;
    void runIntent(
      () =>
        issueTraversal(() => {
          void api.traverseTo!(key).finished.catch(() => finishTraversal(false));
        }),
      url.href,
    );
  } else void requestNavigation(url.href, { replace: navigation.navigationType === 'replace' });
}

function handleRecovery(event: PopStateEvent, index: number) {
  const recovery = recovering!;
  event.stopImmediatePropagation();
  if (index !== recovery.source.index) {
    originalGo(recovery.source.index - index);
    return;
  }
  position = recovery.source;
  if (recovery.phase !== 'restore') return;
  recovery.phase = 'ask';
  void runIntent(() => {
    recovering = null;
    return issueTraversal(() => originalGo(recovery.target.index - recovery.source.index));
  }, recovery.target.url).finally(() => {
    if (recovering === recovery) recovering = null;
  });
}

function handlePopState(event: PopStateEvent) {
  const index = indexOf(event.state);
  if (bypass || index === null) return;
  if (allowedTraversal) {
    remember(index);
    finishTraversal(true);
    return;
  }
  if (recovering) {
    handleRecovery(event, index);
    return;
  }
  const target = snapshot(index);
  if (index !== position.index && !sameContext(target.url) && guards.size > 0) {
    event.stopImmediatePropagation();
    recovering = { source: position, target, phase: 'restore' };
    originalGo(position.index - index);
    return;
  }
  remember(index);
}

function handleAnchor(event: MouseEvent) {
  if (
    guards.size === 0 ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const anchor =
    event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
  if (!anchor || anchor.download || (anchor.target && anchor.target !== '_self')) return;
  const url = new URL(anchor.href, window.location.href);
  if (
    url.origin !== window.location.origin ||
    sameContext(url.href) ||
    url.pathname.startsWith('/api/')
  )
    return;
  event.preventDefault();
  event.stopImmediatePropagation();
  void requestNavigation(url.href);
}

export function registerNavigationGuard(guard: () => Promise<boolean>) {
  installNavigationGuard();
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

export function installNavigationGuard(): () => void {
  if (installed) return () => {};
  installed = true;
  const push = window.history.pushState;
  const replace = window.history.replaceState;
  originalGo = window.history.go.bind(window.history);
  const api = getNavigationApi();
  const initialIndex = indexOf(window.history.state) ?? api?.currentEntry?.index ?? 0;
  position = snapshot(initialIndex);
  const wrappedPush: History['pushState'] = (data, unused, url) => {
    const index = position.index + 1;
    ++bypass;
    try {
      push.call(window.history, { ...stateObject(data), [HISTORY_INDEX]: index }, unused, url);
    } finally {
      --bypass;
    }
    for (const existing of knownEntries.keys())
      if (existing >= index) knownEntries.delete(existing);
    remember(index);
  };
  const wrappedReplace: History['replaceState'] = (data, unused, url) => {
    ++bypass;
    try {
      replace.call(
        window.history,
        { ...stateObject(data), [HISTORY_INDEX]: position.index },
        unused,
        url,
      );
    } finally {
      --bypass;
    }
    remember(position.index);
  };
  window.history.pushState = wrappedPush;
  window.history.replaceState = wrappedReplace;
  wrappedReplace(window.history.state, '', window.location.href);
  window.addEventListener('popstate', handlePopState, true);
  document.addEventListener('click', handleAnchor, true);
  api?.addEventListener('navigate', handleNativeNavigation);
  return () => {
    prepareForcedNavigation();
    installed = false;
    window.removeEventListener('popstate', handlePopState, true);
    document.removeEventListener('click', handleAnchor, true);
    api?.removeEventListener('navigate', handleNativeNavigation);
    if (window.history.pushState === wrappedPush) window.history.pushState = push;
    if (window.history.replaceState === wrappedReplace) window.history.replaceState = replace;
    knownEntries.clear();
  };
}
