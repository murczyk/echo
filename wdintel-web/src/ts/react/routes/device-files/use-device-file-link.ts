import { useSyncExternalStore } from 'react';
import { ECHO_NAVIGATION_EVENT } from '../../../browser/navigation-guard';

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

export function setDeviceFileLink(fileId: string | null, revision: number | null) {
  const url = new URL(window.location.href);
  if (
    fileId === url.searchParams.get('file') &&
    (revision === null ? null : String(revision)) === url.searchParams.get('revision')
  )
    return;
  for (const key of ['file', 'revision', 'extraction', 'section']) url.searchParams.delete(key);
  if (fileId !== null) url.searchParams.set('file', fileId);
  if (revision !== null) url.searchParams.set('revision', String(revision));
  window.history.replaceState(window.history.state, '', url);
}
