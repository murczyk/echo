import {
  AnalyzeKmzResponse,
  AreaOfResponsibility,
  CreatePalitraReq,
  MyScope,
  Organism,
  Palitra,
  PalitraAccess,
  User,
} from '../../../../Bindings';

import {
  AccessType,
  FolderActionDialogState,
  FolderActionKind,
  FolderActionPreview,
  FolderActionResultSummary,
  FolderTableRowView,
  FolderTreeNode,
  KmzColorOption,
  PalitraFormState,
  PalitraRowView,
  TableRowView,
} from './types';

export const DEFAULT_COLOR_HEX = '#00bcd4';

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'Невідома помилка. Спробуйте ще раз.';
}

export function isAdmin(user: User | null): boolean {
  return Boolean(user?.roles.includes('Admin'));
}

export function isEditor(user: User | null): boolean {
  if (!user) return false;
  return user.roles.includes('UnitsEditor') || user.roles.includes('CallsignsEditor');
}

export function canEditScopedLogins(user: User | null): boolean {
  return isEditor(user);
}

export function canModifyPalitra(user: User | null, palitra: Palitra): boolean {
  return isAdmin(user) || palitra.author === user?.name;
}

export function getAvailableAccessTypes(user: User | null, myScope: MyScope | null): AccessType[] {
  const admin = isAdmin(user);
  const editor = isEditor(user);
  const hasOrganism = Boolean(myScope?.organism);
  const hasAorIds = (myScope?.aorIds ?? []).length > 0;

  return [
    'logins',
    ...(admin || hasOrganism ? (['organisms'] as AccessType[]) : []),
    ...(admin || (editor && hasAorIds) ? (['aor'] as AccessType[]) : []),
  ];
}

export function isAccessRestricted(user: User | null): boolean {
  return !isAdmin(user);
}

export function normalizeLogins(logins: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const login of logins) {
    const value = login.trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }

  return normalized;
}

export function toPalitraAccess(form: PalitraFormState): PalitraAccess {
  if (form.accessType === 'logins') {
    return { ByLogins: { logins: normalizeLogins(form.logins) } };
  }

  if (form.accessType === 'organisms') {
    return { ByOrganisms: { organismIds: form.organismIds } };
  }

  return { ByAor: { aorIds: form.aorIds } };
}

export function toCreateReq(form: PalitraFormState): CreatePalitraReq {
  return {
    name: form.name,
    colorHex: form.colorHex,
    access: toPalitraAccess(form),
    sourceFileName: null,
    lastUploadedAtTs: null,
  };
}

export function getInitialCreateForm(user: User | null, myScope: MyScope | null): PalitraFormState {
  const available = getAvailableAccessTypes(user, myScope);
  const defaultOrganismIds = myScope?.organism ? [myScope.organism.id] : [];
  const defaultAccessType =
    defaultOrganismIds.length > 0 && available.includes('organisms') ? 'organisms' : (available[0] ?? 'logins');

  if (isAdmin(user)) {
    return {
      name: '',
      colorHex: DEFAULT_COLOR_HEX,
      accessType: defaultAccessType,
      logins: [],
      organismIds: defaultOrganismIds,
      aorIds: [],
    };
  }

  return {
    name: '',
    colorHex: DEFAULT_COLOR_HEX,
    accessType: defaultAccessType,
    logins: user?.name ? [user.name] : [],
    organismIds: defaultOrganismIds,
    aorIds: myScope?.aorIds ?? [],
  };
}

export function withDefaultOrganismAccess(
  form: PalitraFormState,
  accessType: AccessType,
  myScope: MyScope | null,
): PalitraFormState {
  if (accessType !== 'organisms') return { ...form, accessType };
  if (form.organismIds.length > 0) return { ...form, accessType };
  if (!myScope?.organism) return { ...form, accessType };

  return {
    ...form,
    accessType,
    organismIds: [myScope.organism.id],
  };
}

export function palitraToForm(palitra: Palitra): PalitraFormState {
  if (palitra.accessLogins.length > 0) {
    return {
      name: palitra.name,
      colorHex: palitra.colorHex,
      accessType: 'logins',
      logins: [...palitra.accessLogins],
      organismIds: [],
      aorIds: [],
    };
  }

  if (palitra.accessOrganismIds.length > 0) {
    return {
      name: palitra.name,
      colorHex: palitra.colorHex,
      accessType: 'organisms',
      logins: [],
      organismIds: [...palitra.accessOrganismIds],
      aorIds: [],
    };
  }

  return {
    name: palitra.name,
    colorHex: palitra.colorHex,
    accessType: 'aor',
    logins: [],
    organismIds: [],
    aorIds: [...palitra.accessAorId],
  };
}

export function buildPalitraNameWithSuffix(baseName: string, suffix: string): string {
  const normalizedBaseName = baseName.trim();
  const normalizedSuffix = suffix.trim();
  if (!normalizedSuffix) return normalizedBaseName;
  return normalizedBaseName + ' ' + normalizedSuffix;
}

export function kmzColorOptionsFromAnalysis(analysis: AnalyzeKmzResponse): KmzColorOption[] {
  return analysis.topColors.map((color, index) => ({
    rank: index + 1,
    colorHex: color.colorHex,
    count: color.count,
    selected: true,
    suffix: color.suggestedSuffix?.trim() ?? '',
  }));
}

export function isFormValid(form: PalitraFormState): boolean {
  if (!form.name.trim()) return false;

  if (form.accessType === 'logins') return form.logins.length > 0;
  if (form.accessType === 'organisms') return form.organismIds.length > 0;
  return form.aorIds.length > 0;
}

export function getAccessSummary(
  palitra: Palitra,
  user: User | null,
  myScope: MyScope | null,
  organisms: Organism[],
  aors: AreaOfResponsibility[],
): string {
  const admin = isAdmin(user);
  const isAuthor = palitra.author === user?.name;
  if (!admin && !isAuthor) return '—';

  if (palitra.accessLogins.length > 0) return 'Логіни: ' + palitra.accessLogins.join(', ');

  if (palitra.accessOrganismIds.length > 0) {
    if (admin) {
      const names = palitra.accessOrganismIds
        .map((id) => organisms.find((organism) => organism.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      return names.length > 0 ? 'Підрозділи: ' + names.join(', ') : 'Підрозділи: ' + palitra.accessOrganismIds.join(', ');
    }

    const name = myScope?.organism?.name;
    return name ? 'Підрозділи: ' + name : 'Підрозділи: —';
  }

  if (palitra.accessAorId.length > 0) {
    if (admin) {
      const names = palitra.accessAorId
        .map((id) => aors.find((aor) => aor.id === id)?.name)
        .filter((name): name is string => Boolean(name));
      return names.length > 0 ? 'Смуги: ' + names.join(', ') : 'Смуги: ' + palitra.accessAorId.join(', ');
    }

    const allowed = new Set(myScope?.aorIds ?? []);
    const names = palitra.accessAorId
      .filter((id) => allowed.has(id))
      .map((id) => myScope?.aors.find((aor) => aor.id === id)?.name ?? String(id));
    return names.length > 0 ? 'Смуги: ' + names.join(', ') : 'Смуги: —';
  }

  return 'без доступу';
}

export function mapPalitraToRowView({
  palitra,
  user,
  myScope,
  organisms,
  aors,
  inFlightArchiveId,
  inFlightDeleteId,
  inFlightDownloadId,
  inFlightUploadId,
  depth = 0,
}: {
  palitra: Palitra;
  user: User | null;
  myScope: MyScope | null;
  organisms: Organism[];
  aors: AreaOfResponsibility[];
  inFlightArchiveId: number | null;
  inFlightDeleteId: number | null;
  inFlightDownloadId: number | null;
  inFlightUploadId: number | null;
  depth?: number;
}): PalitraRowView {
  const canModify = canModifyPalitra(user, palitra);
  const archiveInFlight = inFlightArchiveId === palitra.id;
  const deleteInFlight = inFlightDeleteId === palitra.id;
  const downloadInFlight = inFlightDownloadId === palitra.id;
  const uploadInFlight = inFlightUploadId === palitra.id;

  return {
    id: palitra.id,
    kind: 'palitra',
    palitra,
    name: palitra.name,
    depth,
    colorHex: palitra.colorHex,
    sourceFileName: palitra.sourceFileName,
    lastUploadedAtTs: palitra.lastUploadedAtTs,
    author: palitra.author,
    accessSummary: getAccessSummary(palitra, user, myScope, organisms, aors),
    canModify,
    canSelect: canModify && !archiveInFlight && !deleteInFlight && !downloadInFlight && !uploadInFlight,
    archiveInFlight,
    deleteInFlight,
    downloadInFlight,
    uploadInFlight,
  };
}

export function applyRestrictedAccess(
  form: PalitraFormState,
  user: User | null,
  myScope: MyScope | null,
  allowedLogins: string[] = [],
): PalitraFormState {
  if (!isAccessRestricted(user)) return form;

  if (form.accessType === 'logins') {
    if (canEditScopedLogins(user)) {
      const fallbackLogin = user?.name?.trim() ?? '';
      const allowedSet = new Set(normalizeLogins([fallbackLogin, ...allowedLogins]));
      const filteredLogins = normalizeLogins(form.logins.filter((login) => allowedSet.has(login)));

      return {
        ...form,
        logins: filteredLogins.length > 0 ? filteredLogins : (fallbackLogin ? [fallbackLogin] : []),
      };
    }

    return {
      ...form,
      logins: user?.name ? [user.name] : [],
    };
  }

  if (form.accessType === 'organisms') {
    return {
      ...form,
      organismIds: myScope?.organism ? [myScope.organism.id] : [],
    };
  }

  const allowedAorIds = new Set(myScope?.aorIds ?? []);
  const scopedAorIds = myScope?.aorIds ?? [];
  const selectedScopedAorIds = form.aorIds.filter((id) => allowedAorIds.has(id));

  return {
    ...form,
    aorIds: selectedScopedAorIds.length > 0 ? selectedScopedAorIds : scopedAorIds,
  };
}

export function accessTypeLabel(accessType: AccessType): string {
  if (accessType === 'logins') return 'Логіни';
  if (accessType === 'organisms') return 'Підрозділи';
  return 'Смуги';
}

export function normalizeFolderPathForUi(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
    .join('/');
}

export function splitFolderPath(path: string | null): string[] {
  if (!path) return [];
  const normalizedPath = normalizeFolderPathForUi(path);
  return normalizedPath === '' ? [] : [normalizedPath];
}

export function validateFolderPath(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === '') return 'Вкажіть назву папки.';
  if (trimmed.includes('/')) return 'Назва папки не може містити символ /.';
  return null;
}


export function collectFolderPaths(palitras: Palitra[]): string[] {
  const paths = new Set<string>();

  for (const palitra of palitras) {
    const segments = splitFolderPath(palitra.folder);
    if (segments.length === 0) continue;

    const currentPath: string[] = [];
    for (const segment of segments) {
      currentPath.push(segment);
      paths.add(currentPath.join('/'));
    }
  }

  return Array.from(paths).sort((left, right) => left.localeCompare(right, 'uk'));
}

export function buildFolderTree(palitras: Palitra[], user: User | null): FolderTreeNode[] {
  const folderPaths = collectFolderPaths(palitras);
  const folderNodes = new Map<string, FolderTreeNode>();

  for (const path of folderPaths) {
    const segments = splitFolderPath(path);
    folderNodes.set(path, {
      path,
      name: segments[segments.length - 1] ?? path,
      depth: Math.max(segments.length - 1, 0),
      childPaths: [],
      directPalitraIds: [],
      allPalitraIds: [],
      modifiablePalitraIds: [],
    });
  }

  for (const path of folderPaths) {
    const segments = splitFolderPath(path);
    if (segments.length <= 1) continue;

    const parentPath = segments.slice(0, -1).join('/');
    const parentNode = folderNodes.get(parentPath);
    if (!parentNode) continue;
    parentNode.childPaths.push(path);
  }

  const palitrasByFolder = new Map<string, Palitra[]>();
  for (const palitra of palitras) {
    const folderPath = normalizeFolderPathForUi(palitra.folder ?? '');
    if (folderPath === '') continue;

    const current = palitrasByFolder.get(folderPath) ?? [];
    current.push(palitra);
    palitrasByFolder.set(folderPath, current);
  }

  const sortedPaths = [...folderPaths].sort((left, right) => splitFolderPath(right).length - splitFolderPath(left).length);

  for (const path of sortedPaths) {
    const node = folderNodes.get(path);
    if (!node) continue;

    const directPalitras = palitrasByFolder.get(path) ?? [];
    const directIds = directPalitras.map((palitra) => palitra.id);
    const directModifiableIds = directPalitras.filter((palitra) => canModifyPalitra(user, palitra)).map((palitra) => palitra.id);
    const childAllIds = node.childPaths.flatMap((childPath) => folderNodes.get(childPath)?.allPalitraIds ?? []);
    const childModifiableIds = node.childPaths.flatMap((childPath) => folderNodes.get(childPath)?.modifiablePalitraIds ?? []);

    node.childPaths = [...node.childPaths].sort((left, right) => left.localeCompare(right, 'uk'));
    node.directPalitraIds = [...new Set(directIds)].sort((left, right) => left - right);
    node.allPalitraIds = [...new Set([...directIds, ...childAllIds])].sort((left, right) => left - right);
    node.modifiablePalitraIds = [...new Set([...directModifiableIds, ...childModifiableIds])].sort((left, right) => left - right);
  }

  return Array.from(folderNodes.values()).sort((left, right) => left.path.localeCompare(right.path, 'uk'));
}

export function getFolderNodeByPath(tree: FolderTreeNode[], path: string): FolderTreeNode | null {
  const normalizedPath = normalizeFolderPathForUi(path);
  return tree.find((node) => node.path === normalizedPath) ?? null;
}

export function getExistingFolderOptions(tree: FolderTreeNode[]): string[] {
  return tree.map((node) => node.path).sort((left, right) => left.localeCompare(right, 'uk'));
}

export function mapFolderNodeToRowView(node: FolderTreeNode, expandedFolderPaths: Set<string>): FolderTableRowView {
  return {
    id: 'folder:' + node.path,
    kind: 'folder',
    folderPath: node.path,
    name: node.name,
    depth: node.depth,
    totalCount: node.allPalitraIds.length,
    modifiableCount: node.modifiablePalitraIds.length,
    childCount: node.childPaths.length,
    isExpanded: expandedFolderPaths.has(node.path),
    canSelect: false,
    canModify: node.modifiablePalitraIds.length > 0,
    archiveInFlight: false,
    deleteInFlight: false,
    downloadInFlight: false,
    uploadInFlight: false,
    colorHex: null,
    sourceFileName: null,
    lastUploadedAtTs: null,
    author: null,
    accessSummary: 'У папці: ' + String(node.allPalitraIds.length),
  };
}

export function buildTableRows(args: {
  palitras: Palitra[];
  user: User | null;
  myScope: MyScope | null;
  organisms: Organism[];
  aors: AreaOfResponsibility[];
  inFlightArchiveId: number | null;
  inFlightDeleteId: number | null;
  inFlightDownloadId: number | null;
  inFlightUploadId: number | null;
  expandedFolderPaths: Set<string>;
}): TableRowView[] {
  const {
    palitras,
    user,
    myScope,
    organisms,
    aors,
    inFlightArchiveId,
    inFlightDeleteId,
    inFlightDownloadId,
    inFlightUploadId,
    expandedFolderPaths,
  } = args;
  const folderTree = buildFolderTree(palitras, user);
  const nodesByPath = new Map(folderTree.map((node) => [node.path, node]));
  const folderChildren = new Map<string, string[]>();

  for (const node of folderTree) {
    const parentPath = splitFolderPath(node.path).slice(0, -1).join('/');
    const current = folderChildren.get(parentPath) ?? [];
    current.push(node.path);
    folderChildren.set(parentPath, current);
  }

  for (const [path, childPaths] of folderChildren) {
    folderChildren.set(path, [...childPaths].sort((left, right) => left.localeCompare(right, 'uk')));
  }

  const palitrasByFolder = new Map<string, Palitra[]>();
  const rootPalitras: Palitra[] = [];

  for (const palitra of palitras) {
    const folderPath = normalizeFolderPathForUi(palitra.folder ?? '');
    if (folderPath === '') {
      rootPalitras.push(palitra);
      continue;
    }

    const current = palitrasByFolder.get(folderPath) ?? [];
    current.push(palitra);
    palitrasByFolder.set(folderPath, current);
  }

  const sortPalitras = (items: Palitra[]) =>
    [...items].sort((left, right) => {
      const leftTs = left.lastUploadedAtTs ?? Number.NEGATIVE_INFINITY;
      const rightTs = right.lastUploadedAtTs ?? Number.NEGATIVE_INFINITY;
      if (rightTs !== leftTs) return rightTs - leftTs;
      return left.name.localeCompare(right.name, 'uk');
    });

  const rows: TableRowView[] = [];

  function appendFolder(path: string) {
    const node = nodesByPath.get(path);
    if (!node) return;

    rows.push(mapFolderNodeToRowView(node, expandedFolderPaths));

    if (!expandedFolderPaths.has(path)) return;

    const directPalitras = sortPalitras(palitrasByFolder.get(path) ?? []);
    for (const palitra of directPalitras) {
      rows.push(
        mapPalitraToRowView({
          palitra,
          user,
          myScope,
          organisms,
          aors,
          inFlightArchiveId,
          inFlightDeleteId,
          inFlightDownloadId,
          inFlightUploadId,
          depth: node.depth + 1,
        }),
      );
    }

    for (const childPath of folderChildren.get(path) ?? []) {
      appendFolder(childPath);
    }
  }

  for (const rootFolderPath of folderChildren.get('') ?? []) {
    appendFolder(rootFolderPath);
  }

  for (const palitra of sortPalitras(rootPalitras)) {
    rows.push(
      mapPalitraToRowView({
        palitra,
        user,
        myScope,
        organisms,
        aors,
        inFlightArchiveId,
        inFlightDeleteId,
        inFlightDownloadId,
        inFlightUploadId,
        depth: 0,
      }),
    );
  }

  return rows;
}

export function getSelectedModifiablePalitras(rows: PalitraRowView[], selectedIds: number[]): Palitra[] {
  const selectedIdSet = new Set(selectedIds);
  return rows.filter((row) => selectedIdSet.has(row.id) && row.canSelect).map((row) => row.palitra);
}

export function buildAssignFolderPreview(
  rows: PalitraRowView[],
  selectedIds: number[],
  folderPath: string,
): FolderActionPreview {
  const normalizedPath = normalizeFolderPathForUi(folderPath);
  const selectedIdSet = new Set(selectedIds);
  const requestedIds = rows.filter((row) => selectedIdSet.has(row.id)).map((row) => row.id);
  const modifiableRows = rows.filter((row) => selectedIdSet.has(row.id) && row.canSelect);
  const modifiableIds = modifiableRows.map((row) => row.id);
  const modifiableIdSet = new Set(modifiableIds);
  const skippedIds = requestedIds.filter((id) => !modifiableIdSet.has(id));
  const unchangedIds = modifiableRows
    .filter((row) => normalizeFolderPathForUi(row.palitra.folder ?? '') === normalizedPath)
    .map((row) => row.id);

  return {
    requestedIds,
    requestedCount: requestedIds.length,
    modifiableIds,
    modifiableCount: modifiableIds.length,
    skippedIds,
    skippedCount: skippedIds.length,
    unchangedIds,
    unchangedCount: unchangedIds.length,
    descendantFolderCount: 0,
  };
}

export function buildFolderSubtreePreview(node: FolderTreeNode): FolderActionPreview {
  const requestedIds = [...node.allPalitraIds];
  const modifiableIds = [...node.modifiablePalitraIds];
  const modifiableIdSet = new Set(modifiableIds);
  const skippedIds = requestedIds.filter((id) => !modifiableIdSet.has(id));

  return {
    requestedIds,
    requestedCount: requestedIds.length,
    modifiableIds,
    modifiableCount: modifiableIds.length,
    skippedIds,
    skippedCount: skippedIds.length,
    unchangedIds: [],
    unchangedCount: 0,
    descendantFolderCount: node.childPaths.length,
  };
}

export function buildBulkActionResultSummary(requestedIds: number[], changedIds: number[]): FolderActionResultSummary {
  const uniqueRequestedIds = [...new Set(requestedIds)].sort((left, right) => left - right);
  const uniqueChangedIds = [...new Set(changedIds)].sort((left, right) => left - right);
  const changedIdSet = new Set(uniqueChangedIds);
  const skippedIds = uniqueRequestedIds.filter((id) => !changedIdSet.has(id));

  return {
    requestedIds: uniqueRequestedIds,
    requestedCount: uniqueRequestedIds.length,
    changedIds: uniqueChangedIds,
    changedCount: uniqueChangedIds.length,
    skippedIds,
    skippedCount: skippedIds.length,
  };
}

export function formatFolderActionSuccessMessage(kind: FolderActionKind, summary: FolderActionResultSummary): string {
  const label =
    kind === 'assign'
      ? 'Палітри переміщено в папку'
      : kind === 'rename'
        ? 'Папку перейменовано'
        : kind === 'archive'
          ? 'Архівовано палітри з папки'
          : 'Видалено палітри з папки';

  if (summary.changedCount === 0) {
    return label + ': змін не застосовано.';
  }

  if (summary.skippedCount > 0) {
    return label + ': змінено ' + String(summary.changedCount) + ' з ' + String(summary.requestedCount) + '.';
  }

  return label + ': ' + String(summary.changedCount) + '.';
}

export function formatFolderActionPreviewLines(state: FolderActionDialogState): string[] {
  if (state.kind === 'assign') {
    const lines = ['Обрано палітр: ' + String(state.preview.requestedCount)];

    if (state.preview.unchangedCount > 0 && state.nextFolderPath.trim() !== '') {
      lines.push('Уже в цій папці: ' + String(state.preview.unchangedCount));
    }

    if (state.preview.skippedCount > 0) {
      lines.push('Недоступно для зміни: ' + String(state.preview.skippedCount));
    }

    return lines;
  }

  const lines = ['Доступно палітр: ' + String(state.preview.modifiableCount)];

  if (state.preview.skippedCount > 0) {
    lines.push('Недоступно для зміни: ' + String(state.preview.skippedCount));
  }

  return lines;
}
