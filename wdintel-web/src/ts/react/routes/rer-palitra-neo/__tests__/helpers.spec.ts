/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import {
  applyRestrictedAccess,
  buildAssignFolderPreview,
  buildBulkActionResultSummary,
  buildFolderTree,
  buildTableRows,
  formatFolderActionPreviewLines,
  formatFolderActionSuccessMessage,
  getAccessSummary,
  getAvailableAccessTypes,
  getInitialCreateForm,
  getSelectedDownloadablePalitras,
  getSelectedModifiablePalitras,
  canEditScopedLogins,
  canModifyPalitra,
  normalizeFolderPathForUi,
  validateFolderPath,
  normalizeLogins,
  toPalitraAccess,
  withDefaultOrganismAccess,
} from '../helpers';
import type { PalitraFormState, PalitraRowView } from '../types';
import type { MyScope, Organism, Palitra, User } from '../../../../../Bindings';

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
    aors: [
      { id: 11, name: 'North' },
      { id: 12, name: 'South' },
    ] as MyScope['aors'],
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

function makePalitra(
  id: number,
  folder: string | null,
  author = 'operator',
  lastUploadedAtTs: number | null = null,
): Palitra {
  return {
    id,
    name: 'Palitra ' + String(id),
    folder,
    isArchived: false,
    colorHex: '#00bcd4',
    author,
    sourceFileName: null,
    lastUploadedAtTs,
    accessLogins: [],
    accessOrganismIds: [],
    accessAorId: [],
  } as Palitra;
}

function makeRow(
  id: number,
  folder: string | null,
  canSelect = true,
  canModify = canSelect,
): PalitraRowView {
  return {
    id,
    kind: 'palitra',
    palitra: makePalitra(id, folder),
    hiddenByCollapsedFolder: false,
    name: 'Palitra ' + String(id),
    depth: 0,
    colorHex: '#00bcd4',
    sourceFileName: null,
    lastUploadedAtTs: null,
    author: 'operator',
    accessSummary: '—',
    canModify,
    canRetryGoiSourceConversion: false,
    canSelect,
    archiveInFlight: false,
    deleteInFlight: false,
    downloadInFlight: false,
    uploadInFlight: false,
    retryInFlight: false,
  };
}

describe('rer-palitra helpers', () => {
  it('derives available access types from roles and scope', () => {
    expect(getAvailableAccessTypes(makeUser({ roles: ['Admin'] }), makeScope())).toEqual([
      'logins',
      'organisms',
      'aor',
    ]);

    expect(
      getAvailableAccessTypes(makeUser({ roles: ['Rer', 'UnitsEditor'] }), makeScope()),
    ).toEqual(['logins', 'organisms']);

    expect(
      getAvailableAccessTypes(makeUser({ roles: ['Full', 'CallsignsEditor'] }), makeScope()),
    ).toEqual(['logins', 'organisms']);
    expect(getAvailableAccessTypes(makeUser({ roles: ['UnitsEditor'] }), makeScope())).toEqual([]);
    expect(getAvailableAccessTypes(makeUser({ roles: ['Rer'] }), makeScope())).toEqual([
      'logins',
      'organisms',
    ]);
    expect(getAvailableAccessTypes(makeUser({ roles: ['Full'] }), makeScope())).toEqual([
      'logins',
      'organisms',
    ]);
    expect(getAvailableAccessTypes(makeUser({ roles: ['Basic'] }), makeScope())).toEqual([]);
    expect(getAvailableAccessTypes(makeUser({ roles: [] }), null)).toEqual([]);
  });
  it('allows admins to edit scoped logins', () => {
    expect(canEditScopedLogins(makeUser({ roles: ['Admin'] }))).toBe(true);
    expect(canEditScopedLogins(makeUser({ roles: ['Rer', 'UnitsEditor'] }))).toBe(false);
    expect(canEditScopedLogins(makeUser({ roles: ['Full', 'CallsignsEditor'] }))).toBe(false);
    expect(canEditScopedLogins(makeUser({ roles: ['UnitsEditor'] }))).toBe(false);
    expect(canEditScopedLogins(makeUser({ roles: ['Rer'] }))).toBe(false);
    expect(canEditScopedLogins(makeUser({ roles: ['Full'] }))).toBe(false);
    expect(canEditScopedLogins(makeUser({ roles: [] }))).toBe(false);
  });
  it('allows palitra row mutations only for admins or Rer users who authored the palitra', () => {
    const palitra = makePalitra(1, null, 'operator');

    expect(canModifyPalitra(makeUser({ name: 'admin', roles: ['Admin'] }), palitra)).toBe(true);
    expect(
      canModifyPalitra(makeUser({ name: 'operator', roles: ['Rer', 'UnitsEditor'] }), palitra),
    ).toBe(true);
    expect(canModifyPalitra(makeUser({ name: 'operator', roles: ['UnitsEditor'] }), palitra)).toBe(
      false,
    );
    expect(canModifyPalitra(makeUser({ name: 'operator', roles: ['Rer'] }), palitra)).toBe(true);
    expect(
      canModifyPalitra(makeUser({ name: 'other', roles: ['Rer', 'UnitsEditor'] }), palitra),
    ).toBe(false);
  });
  it('creates scoped initial form values for non-admin users', () => {
    const form = getInitialCreateForm(
      makeUser({ name: 'scout', roles: ['Rer', 'UnitsEditor'] }),
      makeScope(),
    );

    expect(form.accessType).toBe('organisms');
    expect(form.logins).toEqual(['scout']);
    expect(form.organismIds).toEqual([5]);
    expect(form.aorIds).toEqual([]);
  });
  it('does not prefill unavailable access scopes for non-palitra roles', () => {
    const form = getInitialCreateForm(makeUser({ name: 'scout', roles: ['Basic'] }), makeScope());

    expect(form.accessType).toBe('logins');
    expect(form.logins).toEqual([]);
    expect(form.organismIds).toEqual([]);
    expect(form.aorIds).toEqual([]);
  });
  it('adds default organism access only when switching into an empty organisms mode', () => {
    const scope = makeScope();

    expect(withDefaultOrganismAccess(makeForm(), 'organisms', scope).organismIds).toEqual([5]);
    expect(
      withDefaultOrganismAccess(makeForm({ organismIds: [77] }), 'organisms', scope).organismIds,
    ).toEqual([77]);
    expect(withDefaultOrganismAccess(makeForm(), 'logins', scope).accessType).toBe('logins');
  });
  it('restricts form access to the current user scope for non-admin users', () => {
    const restrictedUser = makeUser({ name: 'scout', roles: ['Rer', 'UnitsEditor'] });
    const scope = makeScope();

    expect(
      applyRestrictedAccess(
        makeForm({ accessType: 'logins', logins: ['other', 'scout', 'enemy'] }),
        restrictedUser,
        scope,
        ['other', 'scout'],
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
    ).toEqual([]);
  });
  it('restricts Rer-equivalent users without editor role to own login or organism', () => {
    const restrictedUser = makeUser({ name: 'scout', roles: ['Full'] });
    const scope = makeScope();

    expect(
      applyRestrictedAccess(
        makeForm({ accessType: 'logins', logins: ['other', 'scout', 'enemy'] }),
        restrictedUser,
        scope,
        ['other', 'scout'],
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
      applyRestrictedAccess(makeForm({ accessType: 'aor', aorIds: [11] }), restrictedUser, scope)
        .aorIds,
    ).toEqual([]);
  });
  it('clears restricted access for users without palitra roles', () => {
    const restrictedUser = makeUser({ name: 'scout', roles: ['Basic'] });
    const scope = makeScope();

    expect(
      applyRestrictedAccess(
        makeForm({ accessType: 'logins', logins: ['scout'] }),
        restrictedUser,
        scope,
      ).logins,
    ).toEqual([]);

    expect(
      applyRestrictedAccess(
        makeForm({ accessType: 'organisms', organismIds: [5] }),
        restrictedUser,
        scope,
      ).organismIds,
    ).toEqual([]);

    expect(
      applyRestrictedAccess(makeForm({ accessType: 'aor', aorIds: [11] }), restrictedUser, scope)
        .aorIds,
    ).toEqual([]);
  });
  it('falls back to own login when scoped editor selections contain no allowed logins', () => {
    const restrictedUser = makeUser({ name: 'scout', roles: ['Rer', 'UnitsEditor'] });

    expect(
      applyRestrictedAccess(
        makeForm({ accessType: 'logins', logins: ['enemy'] }),
        restrictedUser,
        makeScope(),
        ['other'],
      ).logins,
    ).toEqual(['scout']);
  });
  it('clears restricted AOR access for non-admin users', () => {
    const restrictedUser = makeUser({ name: 'scout', roles: ['Rer', 'UnitsEditor'] });
    const scope = makeScope();

    expect(
      applyRestrictedAccess(makeForm({ accessType: 'aor', aorIds: [] }), restrictedUser, scope)
        .aorIds,
    ).toEqual([]);

    expect(
      applyRestrictedAccess(makeForm({ accessType: 'aor', aorIds: [99] }), restrictedUser, scope)
        .aorIds,
    ).toEqual([]);
  });
  it('does not mark root palitras as already in target folder before a folder is chosen', () => {
    const preview = buildAssignFolderPreview([makeRow(1, null), makeRow(2, '')], [1, 2], '');

    expect(preview.requestedCount).toBe(2);
    expect(preview.unchangedIds).toEqual([]);
    expect(preview.unchangedCount).toBe(0);
  });
  it('rejects slash in folder names because this UI supports only flat folders', () => {
    expect(validateFolderPath('North')).toBe(null);
    expect(validateFolderPath(' North ')).toBe(null);
    expect(validateFolderPath('')).toBe('Вкажіть назву папки.');
    expect(validateFolderPath('North/Alpha')).toBe('Назва папки не може містити символ /.');
    expect(validateFolderPath('North / Alpha')).toBe('Назва папки не може містити символ /.');
  });
  it('marks GOI-owned palitras as selectable but not modifiable', () => {
    const goiOwnedPalitra = {
      ...makePalitra(9, null, 'operator', 10),
      goiOwned: true,
    } as Palitra;

    const rows = buildTableRows({
      palitras: [goiOwnedPalitra],
      user: makeUser({ name: 'operator', roles: ['Admin'] }),
      myScope: null,
      organisms: [],
      aors: [],
      inFlightArchiveId: null,
      inFlightDeleteId: null,
      inFlightDownloadId: null,
      inFlightUploadId: null,
      inFlightRetryId: null,
      expandedFolderPaths: new Set(),
    });
    const row = rows.find((item) => item.kind === 'palitra' && item.id === 9);

    expect(row).toMatchObject({ canModify: false, canSelect: true });
  });
  it('excludes GOI-owned palitras from folder modifiable actions', () => {
    const goiOwnedPalitra = {
      ...makePalitra(9, 'GOI', 'operator', 10),
      goiOwned: true,
    } as Palitra;

    const rows = buildTableRows({
      palitras: [goiOwnedPalitra],
      user: makeUser({ name: 'operator', roles: ['Admin'] }),
      myScope: null,
      organisms: [],
      aors: [],
      inFlightArchiveId: null,
      inFlightDeleteId: null,
      inFlightDownloadId: null,
      inFlightUploadId: null,
      inFlightRetryId: null,
      expandedFolderPaths: new Set(['GOI']),
    });
    const folderRow = rows.find((item) => item.kind === 'folder' && item.folderPath === 'GOI');

    expect(folderRow).toMatchObject({ canModify: false, modifiableCount: 0, totalCount: 1 });
  });
  it('keeps read-only palitras downloadable but not modifiable in bulk selections', () => {
    const rows = [makeRow(1, null, true, true), makeRow(2, null, true, false)];

    expect(getSelectedDownloadablePalitras(rows, [1, 2]).map((palitra) => palitra.id)).toEqual([
      1, 2,
    ]);
    expect(getSelectedModifiablePalitras(rows, [1, 2]).map((palitra) => palitra.id)).toEqual([1]);
  });
});
