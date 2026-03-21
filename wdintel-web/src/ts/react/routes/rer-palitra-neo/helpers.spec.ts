/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import {
  applyRestrictedAccess,
  getAccessSummary,
  getAvailableAccessTypes,
  getInitialCreateForm,
  normalizeLogins,
  toPalitraAccess,
  withDefaultOrganismAccess,
} from './helpers';
import type { PalitraFormState } from './types';
import type { MyScope, Organism, Palitra, User } from '../../../../Bindings';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 1,
    name: 'operator',
    login: 'operator',
    roles: [],
    ...overrides,
  } as User;
}

function makeScope(overrides: Partial<MyScope> = {}): MyScope {
  return {
    organism: { id: 5, name: 'Scope Unit' } as Organism,
    aorIds: [11, 12],
    aors: [{ id: 11, name: 'North' }, { id: 12, name: 'South' }] as MyScope['aors'],
    ...overrides,
  } as MyScope;
}

function makeForm(overrides: Partial<PalitraFormState> = {}): PalitraFormState {
  return {
    name: 'Test',
    colorHex: '#00bcd4',
    accessType: 'logins',
    logins: ['operator'],
    organismIds: [],
    aorIds: [],
    ...overrides,
  };
}

describe('rer-palitra helpers', () => {
  it('derives available access types from roles and scope', () => {
    expect(getAvailableAccessTypes(makeUser({ roles: ['Admin'] }), makeScope())).toEqual([
      'logins',
      'organisms',
      'aor',
    ]);

    expect(getAvailableAccessTypes(makeUser({ roles: ['UnitsEditor'] }), makeScope())).toEqual([
      'logins',
      'organisms',
      'aor',
    ]);

    expect(getAvailableAccessTypes(makeUser({ roles: [] }), null)).toEqual(['logins']);
  });

  it('normalizes login access by trimming, deduplicating, and preserving order', () => {
    expect(normalizeLogins(['  alpha ', '', 'beta', 'alpha', ' beta '])).toEqual(['alpha', 'beta']);
    expect(toPalitraAccess(makeForm({ logins: ['  alpha ', 'beta', 'alpha'] }))).toEqual({
      ByLogins: { logins: ['alpha', 'beta'] },
    });
  });

  it('creates scoped initial form values for non-admin users', () => {
    const form = getInitialCreateForm(makeUser({ name: 'scout', roles: ['UnitsEditor'] }), makeScope());

    expect(form.accessType).toBe('organisms');
    expect(form.logins).toEqual(['scout']);
    expect(form.organismIds).toEqual([5]);
    expect(form.aorIds).toEqual([11, 12]);
  });

  it('adds default organism access only when switching into an empty organisms mode', () => {
    const scope = makeScope();

    expect(withDefaultOrganismAccess(makeForm(), 'organisms', scope).organismIds).toEqual([5]);
    expect(withDefaultOrganismAccess(makeForm({ organismIds: [77] }), 'organisms', scope).organismIds).toEqual([77]);
    expect(withDefaultOrganismAccess(makeForm(), 'logins', scope).accessType).toBe('logins');
  });

  it('restricts form access to the current user scope for non-admin users', () => {
    const restrictedUser = makeUser({ name: 'scout', roles: ['UnitsEditor'] });
    const scope = makeScope();

    expect(
      applyRestrictedAccess(
        makeForm({ accessType: 'logins', logins: ['other', 'scout'] }),
        restrictedUser,
        scope,
      ).logins,
    ).toEqual(['scout']);

    expect(
      applyRestrictedAccess(
        makeForm({ accessType: 'organisms', organismIds: [999] }),
        restrictedUser,
        scope,
      ).organismIds,
    ).toEqual([5]);

    expect(
      applyRestrictedAccess(
        makeForm({ accessType: 'aor', aorIds: [11, 99] }),
        restrictedUser,
        scope,
      ).aorIds,
    ).toEqual([11]);
  });

  it('defaults restricted AOR access to the current scope when nothing scoped is selected', () => {
    const restrictedUser = makeUser({ name: 'scout', roles: ['UnitsEditor'] });
    const scope = makeScope();

    expect(
      applyRestrictedAccess(
        makeForm({ accessType: 'aor', aorIds: [] }),
        restrictedUser,
        scope,
      ).aorIds,
    ).toEqual([11, 12]);

    expect(
      applyRestrictedAccess(
        makeForm({ accessType: 'aor', aorIds: [99] }),
        restrictedUser,
        scope,
      ).aorIds,
    ).toEqual([11, 12]);
  });

  it('renders access summaries using visible names for admins and scoped users', () => {
    const palitra = {
      author: 'operator',
      accessLogins: [],
      accessOrganismIds: [5, 99],
      accessAorId: [],
    } as Palitra;
    const organisms = [{ id: 5, name: 'Scope Unit' }] as Organism[];

    expect(getAccessSummary(palitra, makeUser({ roles: ['Admin'] }), makeScope(), organisms, [])).toBe(
      'Підрозділи: Scope Unit',
    );

    expect(getAccessSummary(palitra, makeUser({ name: 'operator', roles: ['UnitsEditor'] }), makeScope(), organisms, [])).toBe(
      'Підрозділи: Scope Unit',
    );
  });
});
