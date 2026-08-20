import { expect, it } from 'vitest';

import { buildAccessItems } from './zone-group-access';

it('keeps equal user and organism names distinguishable', () => {
  expect(
    buildAccessItems(
      ['user-id'],
      [{ loginId: 'user-id', login: 'Однакове імʼя' }] as any,
      [42],
      new Map([[42, { id: 42, name: 'Однакове імʼя' } as any]]),
      new Map(),
    ),
  ).toEqual([
    { kind: 'user', id: 'user-id', label: 'Користувач: Однакове імʼя' },
    { kind: 'organism', id: 42, label: 'Організм: Однакове імʼя' },
  ]);
});

it('returns no entries when access is unrestricted', () => {
  expect(buildAccessItems(undefined, undefined, undefined, new Map(), new Map())).toEqual([]);
});
