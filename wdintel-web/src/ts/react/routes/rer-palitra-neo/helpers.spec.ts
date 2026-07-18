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
} from './helpers';
import type { PalitraFormState, PalitraRowView } from './types';
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

  it('normalizes login access by trimming, deduplicating, and preserving order', () => {
    expect(normalizeLogins(['  alpha ', '', 'beta', 'alpha', ' beta '])).toEqual(['alpha', 'beta']);
    expect(toPalitraAccess(makeForm({ logins: ['  alpha ', 'beta', 'alpha'] }))).toEqual({
      ByLogins: { logins: ['alpha', 'beta'] },
    });
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

  it('renders access summaries using visible names for admins and scoped users', () => {
    const palitra = {
      author: 'operator',
      accessLogins: [],
      accessOrganismIds: [5, 99],
      accessAorId: [],
    } as Palitra;
    const organisms = [{ id: 5, name: 'Scope Unit' }] as Organism[];

    expect(
      getAccessSummary(palitra, makeUser({ roles: ['Admin'] }), makeScope(), organisms, []),
    ).toBe('Підрозділи: Scope Unit');

    expect(
      getAccessSummary(
        palitra,
        makeUser({ name: 'operator', roles: ['UnitsEditor'] }),
        makeScope(),
        organisms,
        [],
      ),
    ).toBe('Підрозділи: Scope Unit');
  });

  it('does not mark root palitras as already in target folder before a folder is chosen', () => {
    const preview = buildAssignFolderPreview([makeRow(1, null), makeRow(2, '')], [1, 2], '');

    expect(preview.requestedCount).toBe(2);
    expect(preview.unchangedIds).toEqual([]);
    expect(preview.unchangedCount).toBe(0);
  });

  it('builds flat folder nodes for rer-palitra-neo folder UI', () => {
    expect(normalizeFolderPathForUi('  North  ')).toBe('North');

    const tree = buildFolderTree(
      [makePalitra(1, 'North'), makePalitra(2, 'South'), makePalitra(3, 'Bravo', 'other')],
      makeUser({ name: 'operator', roles: ['Admin'] }),
    );

    expect(tree.map((node) => node.path)).toEqual(['Bravo', 'North', 'South']);
    expect(tree.find((node) => node.path === 'North')?.allPalitraIds).toEqual([1]);
    expect(tree.find((node) => node.path === 'South')?.allPalitraIds).toEqual([2]);
    expect(tree.every((node) => node.depth === 0)).toBe(true);
  });

  it('rejects slash in folder names because this UI supports only flat folders', () => {
    expect(validateFolderPath('North')).toBe(null);
    expect(validateFolderPath(' North ')).toBe(null);
    expect(validateFolderPath('')).toBe('Вкажіть назву папки.');
    expect(validateFolderPath('North/Alpha')).toBe('Назва папки не може містити символ /.');
    expect(validateFolderPath('North / Alpha')).toBe('Назва папки не може містити символ /.');
  });

  it('builds grouped table rows for MRT without nesting support', () => {
    const rows = buildTableRows({
      palitras: [
        makePalitra(1, null, 'operator', 50),
        makePalitra(2, 'North', 'operator', 40),
        makePalitra(3, 'North/Sub', 'operator', 30),
        makePalitra(4, 'North', 'other', 20),
      ],
      user: makeUser({ name: 'operator', roles: ['Rer', 'UnitsEditor'] }),
      myScope: null,
      organisms: [],
      aors: [],
      inFlightArchiveId: null,
      inFlightDeleteId: null,
      inFlightDownloadId: null,
      inFlightUploadId: null,
      expandedFolderPaths: new Set(['North']),
    });

    expect(
      rows.map((row) =>
        row.kind === 'folder' ? 'folder:' + row.folderPath : 'palitra:' + String(row.id),
      ),
    ).toEqual([
      'folder:North',
      'palitra:2',
      'palitra:4',
      'folder:North/Sub',
      'palitra:3',
      'palitra:1',
    ]);

    const folderRow = rows.find((row) => row.kind === 'folder' && row.folderPath === 'North');
    expect(folderRow).toMatchObject({
      totalCount: 2,
      modifiableCount: 1,
      isExpanded: true,
    });

    const nestedPalitraRow = rows.find((row) => row.kind === 'palitra' && row.id === 3);
    expect(nestedPalitraRow).toMatchObject({ hiddenByCollapsedFolder: true });
  });

  it('builds assign previews and human preview lines', () => {
    const preview = buildAssignFolderPreview(
      [
        makeRow(1, 'North/Alpha', true),
        makeRow(2, 'North/Alpha', false),
        makeRow(3, 'North/Beta', true),
      ],
      [1, 2, 3],
      'North/Alpha',
    );

    expect(preview.requestedIds).toEqual([1, 2, 3]);
    expect(preview.modifiableIds).toEqual([1, 3]);
    expect(preview.skippedIds).toEqual([2]);
    expect(preview.unchangedIds).toEqual([1]);

    expect(
      formatFolderActionPreviewLines({
        kind: 'assign',
        folderPath: '',
        nextFolderPath: 'North/Alpha',
        targetPalitraIds: preview.modifiableIds,
        preview,
      }),
    ).toEqual(['Обрано палітр: 3', 'Уже в цій папці: 1', 'Недоступно для зміни: 1']);
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

  it('builds bulk result summaries', () => {
    const summary = buildBulkActionResultSummary([1, 3], [3]);
    expect(summary.changedIds).toEqual([3]);
    expect(summary.skippedIds).toEqual([1]);
    expect(formatFolderActionSuccessMessage('assign', summary)).toBe(
      'Палітри переміщено в папку: змінено 1 з 2.',
    );
  });
});
