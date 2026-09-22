import { navigateWithinSpa } from '../../utils/browser';

const SYNC_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isValidSyncId(syncId: string | null): boolean {
  return syncId === null || SYNC_ID_PATTERN.test(syncId);
}

export function selectDeviceSyncSession(syncId: string | null) {
  const url = new URL(window.location.href);
  if (url.searchParams.get('sync_id') === syncId) return;
  if (syncId === null) url.searchParams.delete('sync_id');
  else url.searchParams.set('sync_id', syncId);
  navigateWithinSpa(`${url.pathname}${url.search}${url.hash}`);
}
