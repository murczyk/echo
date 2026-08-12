import { postJson } from './client';

export function startGroupStatsCacheBackfill(): Promise<number> {
  return postJson<number>('/api/admin/group-stats-cache/backfill');
}
