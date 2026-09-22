import type { AuthorIdentity } from '../../Bindings';
import { fetchAuthorIdentities } from './services/api/author-identities';
import { AUTH_UNAUTHORIZED_EVENT } from './auth-redirect';
import { isUnauthorizedError } from './services/api/client';

export const AUTHOR_IDENTITIES_ERROR_EVENT = 'echo-author-identities-error';
const AUTHOR_IDENTITIES_BATCH_SIZE = 200;
export type AuthorKey = `login:${string}` | `id:${string}`;
const identities = new Map<AuthorKey, AuthorIdentity | null>();
const listeners = new Map<AuthorKey, Set<() => void>>();
const pending = new Set<AuthorKey>();
const queued = new Set<AuthorKey>();
let scheduled = false;
let generation = 0;

export function authorKey(login?: string | null, id?: string | null): AuthorKey | null {
  if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return `id:${id.toLowerCase()}`;
  }
  return login ? `login:${login}` : null;
}

export function getAuthor(key: AuthorKey | null): AuthorIdentity | null | undefined {
  return key ? identities.get(key) : null;
}

function publish(key: AuthorKey) {
  listeners.get(key)?.forEach((listener) => listener());
}

function enqueue(key: AuthorKey) {
  if (identities.has(key) || pending.has(key)) return;
  queued.add(key);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}

async function flush() {
  scheduled = false;
  const keys = [...queued].slice(0, AUTHOR_IDENTITIES_BATCH_SIZE);
  if (!keys.length) return;
  keys.forEach((key) => {
    queued.delete(key);
    pending.add(key);
  });
  const requestGeneration = generation;
  try {
    const { authors } = await fetchAuthorIdentities({
      logins: keys.filter((key) => key.startsWith('login:')).map((key) => key.slice(6)),
      ids: keys.filter((key) => key.startsWith('id:')).map((key) => key.slice(3)),
    });
    if (requestGeneration !== generation) return;
    keys.forEach((key) => identities.set(key, null));
    authors.forEach((author) => {
      identities.set(`login:${author.login}`, author);
      identities.set(`id:${author.id}`, author);
    });
    keys.forEach(publish);
  } catch (error) {
    if (requestGeneration !== generation) return;
    keys.forEach((key) => identities.set(key, null));
    if (!isUnauthorizedError(error)) {
      window.dispatchEvent(
        new CustomEvent(AUTHOR_IDENTITIES_ERROR_EVENT, {
          detail: `Помилка завантаження авторів: ${error instanceof Error ? error.message : 'невідома помилка'}`,
        }),
      );
    }
  } finally {
    if (requestGeneration === generation) keys.forEach((key) => pending.delete(key));
    if (queued.size && !scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  }
}

export function subscribeAuthor(key: AuthorKey | null, listener: () => void): () => void {
  if (!key) return () => {};
  refreshAuthorsOnNavigation();
  const subscribers = listeners.get(key) ?? new Set();
  subscribers.add(listener);
  listeners.set(key, subscribers);
  enqueue(key);
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) listeners.delete(key);
  };
}

export function refreshAuthors(updated?: AuthorIdentity) {
  generation += 1;
  identities.clear();
  pending.clear();
  queued.clear();
  if (updated) {
    identities.set(`login:${updated.login}`, updated);
    identities.set(`id:${updated.id}`, updated);
  }
  listeners.forEach((_, key) => {
    publish(key);
    enqueue(key);
  });
}

let currentUrl = typeof window === 'undefined' ? '' : window.location.href;
function refreshAuthorsOnNavigation() {
  if (window.location.href === currentUrl) return;
  currentUrl = window.location.href;
  refreshAuthors();
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', refreshAuthorsOnNavigation);
  (window as Window & { navigation?: EventTarget }).navigation?.addEventListener(
    'currententrychange',
    refreshAuthorsOnNavigation,
  );
  window.addEventListener(AUTH_UNAUTHORIZED_EVENT, () => {
    generation += 1;
    identities.clear();
    pending.clear();
    queued.clear();
    listeners.forEach((_, key) => publish(key));
  });
}
