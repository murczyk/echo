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

function makePalitra(id: number, folder: string | null, author = 'operator', lastUploadedAtTs: number | null = null): Palitra {
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

function makeRow(id: number, folder: string | null, canSelect = true): PalitraRowView {
  return {
    id,
    kind: 'palitra',
    palitra: makePalitra(id, folder),
    name: 'Palitra ' + String(id),
    depth: 0,
    colorHex: '#00bcd4',
    sourceFileName: null,
    lastUploadedAtTs: null,
    author: 'operator',
    accessSummary: '—',
    canModify: canSelect,
    canSelect,
    archiveInFlight: false,
    deleteInFlight: false,
    downloadInFlight: false,
    uploadInFlight: false,
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
        makeForm({ accessType: 'logins', logins: ['other', 'scout', 'enemy'] }),
        restrictedUser,
        scope,
        ['other', 'scout'],
      ).logins,
    ).toEqual(['other', 'scout']);

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

  it('falls back to own login when scoped editor selections contain no allowed logins', () => {
    const restrictedUser = makeUser({ name: 'scout', roles: ['UnitsEditor'] });

    expect(
      applyRestrictedAccess(
        makeForm({ accessType: 'logins', logins: ['enemy'] }),
        restrictedUser,
        makeScope(),
        ['other'],
      ).logins,
    ).toEqual(['scout']);
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

  it('normalizes folder paths and builds folder tree aggregates', () => {
    expect(normalizeFolderPathForUi('  North /  Alpha / ')).toBe('North/Alpha');

    const tree = buildFolderTree(
      [
        makePalitra(1, 'North/Alpha'),
        makePalitra(2, 'North/Alpha/Sub'),
        makePalitra(3, 'North/Beta', 'other'),
      ],
      makeUser({ name: 'operator', roles: ['Admin'] }),
    );

    expect(tree.map((node) => node.path)).toEqual(['North/Alpha', 'North/Alpha/Sub', 'North/Beta']);
    expect(tree.find((node) => node.path === 'North/Alpha')?.allPalitraIds).toEqual([1]);
    expect(tree.find((node) => node.path === 'North/Alpha/Sub')?.allPalitraIds).toEqual([2]);
    expect(tree.every((node) => node.depth === 0)).toBe(true);
  });

  it('rejects slash in folder names', () => {
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
      user: makeUser({ name: 'operator' }),
      myScope: null,
      organisms: [],
      aors: [],
      inFlightArchiveId: null,
      inFlightDeleteId: null,
      inFlightDownloadId: null,
      inFlightUploadId: null,
      expandedFolderPaths: new Set(['North']),
    });

    expect(rows.map((row) => row.kind === 'folder' ? 'folder:' + row.folderPath : 'palitra:' + String(row.id))).toEqual([
      'folder:North',
      'palitra:2',
      'palitra:4',
      'folder:North/Sub',
      'palitra:1',
    ]);

    const folderRow = rows.find((row) => row.kind === 'folder' && row.folderPath === 'North');
    expect(folderRow).toMatchObject({
      totalCount: 2,
      modifiableCount: 1,
      isExpanded: true,
    });
  });

  it('builds assign previews and human preview lines', () => {
    const preview = buildAssignFolderPreview(
      [makeRow(1, 'North/Alpha', true), makeRow(2, 'North/Alpha', false), makeRow(3, 'North/Beta', true)],
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

  it('builds bulk result summaries', () => {
    const summary = buildBulkActionResultSummary([1, 3], [3]);
    expect(summary.changedIds).toEqual([3]);
    expect(summary.skippedIds).toEqual([1]);
    expect(formatFolderActionSuccessMessage('assign', summary)).toBe('Палітри переміщено в папку: змінено 1 з 2.');
  });
});
