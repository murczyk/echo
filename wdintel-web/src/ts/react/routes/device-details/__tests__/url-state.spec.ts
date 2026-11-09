/** @vitest-environment happy-dom */
import { beforeEach, expect, it, vi } from 'vitest';
import { selectDeviceSyncSession } from '../url-state';
const navigate = vi.hoisted(() => vi.fn((path: string) => window.history.pushState({}, '', path)));
vi.mock('../../../utils/browser', () => ({ navigateWithinSpa: navigate }));
const FIRST = '018f0000-0000-7000-8000-000000000001';
const SECOND = '018f0000-0000-7000-8000-000000000002';
const context = [
  'file',
  'revision',
  'extraction',
  'section',
  'directory',
  'directory_revision',
  'search',
  'search_scope',
  'search_scope_revision',
  'search_global',
  'search_view',
  'search_root',
];
beforeEach(() => {
  vi.clearAllMocks();
  const query = new URLSearchParams({ sync_id: FIRST, keep: '1', untagged: '1' });
  for (const field of context)
    query.set(field, field.includes('revision') ? '3' : 'archive-context');
  window.history.replaceState({}, '', `/devices/${FIRST}/files?${query}#retained`);
});
for (const target of [SECOND, null]) {
  it(`#3930 clears archive search and selection when switching session to ${target}`, () => {
    selectDeviceSyncSession(target);
    const query = new URLSearchParams(window.location.search);
    expect(query.get('sync_id')).toBe(target);
    for (const field of context) expect(query.has(field), field).toBe(false);
    expect(query.get('keep')).toBe('1');
    expect(query.get('untagged')).toBe('1');
    expect(window.location.hash).toBe('#retained');
  });
}
it('#3930 keeps search intact when selecting the same session', () => {
  const previous = window.location.href;
  selectDeviceSyncSession(FIRST);
  expect(window.location.href).toBe(previous);
  expect(navigate).not.toHaveBeenCalled();
});
