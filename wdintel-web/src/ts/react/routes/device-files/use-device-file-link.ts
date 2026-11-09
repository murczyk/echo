import { useSyncExternalStore } from 'react';
import { ECHO_NAVIGATION_EVENT, requestNavigation } from '../../../browser/navigation-guard';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function subscribe(listener: () => void) {
  window.addEventListener('popstate', listener);
  window.addEventListener(ECHO_NAVIGATION_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(ECHO_NAVIGATION_EVENT, listener);
  };
}

export function useDeviceFileLink() {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  const query = new URLSearchParams(search);
  const fileId = query.get('file');
  const revision = query.has('revision') ? Number(query.get('revision')) : null;
  const extraction = query.get('extraction');
  const section = query.has('section') ? Number(query.get('section')) : null;
  return fileId &&
    UUID.test(fileId) &&
    (revision === null || (Number.isSafeInteger(revision) && revision > 0))
    ? {
        fileId,
        revision,
        extractionRevision: extraction && UUID.test(extraction) ? extraction : null,
        section: section !== null && Number.isSafeInteger(section) && section > 0 ? section : null,
      }
    : null;
}

export function useDeviceDirectoryLink() {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  const entryId = new URLSearchParams(search).get('directory');
  return entryId && UUID.test(entryId) ? entryId : null;
}

export function useDeviceDirectoryRevision() {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  const revision = Number(new URLSearchParams(search).get('directory_revision'));
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

export function deviceFileLocationHref(
  fileId: string | null,
  revision: number | null,
  directoryId: string | null,
  directoryRevision: number | null = null,
  options?: { searchView?: 'results' | 'folder'; clearSearch?: boolean },
) {
  const url = new URL(window.location.href);
  const searchRootId =
    url.searchParams.get('search_root') ??
    (url.searchParams.get('search_view') === 'folder'
      ? url.searchParams.get('directory')
      : directoryId);
  for (const key of [
    'file',
    'revision',
    'extraction',
    'section',
    'directory',
    'directory_revision',
  ])
    url.searchParams.delete(key);
  if (fileId !== null) url.searchParams.set('file', fileId);
  if (revision !== null) url.searchParams.set('revision', String(revision));
  if (directoryId !== null) url.searchParams.set('directory', directoryId);
  if (directoryRevision !== null)
    url.searchParams.set('directory_revision', String(directoryRevision));
  if (options?.clearSearch) {
    for (const key of [
      'search',
      'search_scope',
      'search_scope_revision',
      'search_global',
      'search_view',
      'search_root',
    ])
      url.searchParams.delete(key);
  } else if (url.searchParams.has('search')) {
    const searchView = options?.searchView ?? 'folder';
    url.searchParams.set('search_view', searchView);
    if (searchView === 'folder' && searchRootId && UUID.test(searchRootId))
      url.searchParams.set('search_root', searchRootId);
    else url.searchParams.delete('search_root');
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function setDeviceFileLink(
  fileId: string | null,
  revision: number | null,
  directoryId: string | null = null,
  directoryRevision: number | null = null,
  options?: { replace?: boolean; searchView?: 'results' | 'folder'; clearSearch?: boolean },
) {
  const href = deviceFileLocationHref(fileId, revision, directoryId, directoryRevision, options);
  if (href === `${window.location.pathname}${window.location.search}${window.location.hash}`)
    return;
  void requestNavigation(href, options);
}

export function useDeviceFileSearchLink() {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  const query = new URLSearchParams(search);
  const term = query.get('search')?.trim();
  const scopeId = query.get('search_scope');
  const rootId = query.get('search_root');
  const revision = Number(query.get('search_scope_revision'));
  return term
    ? {
        query: term,
        scopeId: scopeId && UUID.test(scopeId) ? scopeId : null,
        rootId: rootId && UUID.test(rootId) ? rootId : null,
        scopeRevision: Number.isSafeInteger(revision) && revision > 0 ? revision : null,
        global: query.get('search_global') === '1',
        view: query.get('search_view') === 'folder' ? ('folder' as const) : ('results' as const),
      }
    : null;
}

export function deviceFileSearchHref(
  query: string,
  scopeId: string | null,
  scopeRevision: number | null,
  global: boolean,
) {
  const url = new URL(
    deviceFileLocationHref(null, null, scopeId, scopeRevision, { clearSearch: true }),
    window.location.origin,
  );
  url.searchParams.set('search', query);
  if (scopeId) url.searchParams.set('search_scope', scopeId);
  if (scopeRevision) url.searchParams.set('search_scope_revision', String(scopeRevision));
  if (global) url.searchParams.set('search_global', '1');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function setDeviceFileSearchLink(
  query: string,
  scopeId: string | null,
  scopeRevision: number | null,
  global: boolean,
) {
  void requestNavigation(deviceFileSearchHref(query, scopeId, scopeRevision, global));
}
