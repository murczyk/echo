import { AreaOfResponsibility, MyScope, Organism, Palitra, User } from '../../../../Bindings';

import { canModifyPalitra, getAccessSummary } from './helpers-access';
import {
  buildFolderTree,
  mapFolderNodeToRowView,
  normalizeFolderPathForUi,
  splitFolderPath,
} from './helpers-folders';
import { PalitraRowView, TableRowView } from './types';

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
  inFlightRetryId,
  depth = 0,
  hiddenByCollapsedFolder = false,
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
  inFlightRetryId: number | null;
  depth?: number;
  hiddenByCollapsedFolder?: boolean;
}): PalitraRowView {
  const canModify = canModifyPalitra(user, palitra);
  const archiveInFlight = inFlightArchiveId === palitra.id;
  const deleteInFlight = inFlightDeleteId === palitra.id;
  const downloadInFlight = inFlightDownloadId === palitra.id;
  const uploadInFlight = inFlightUploadId === palitra.id;
  const retryInFlight = inFlightRetryId === palitra.id;

  return {
    id: palitra.id,
    kind: 'palitra',
    palitra,
    hiddenByCollapsedFolder,
    name: palitra.name,
    depth,
    colorHex: palitra.colorHex,
    sourceFileName: palitra.sourceFileName,
    lastUploadedAtTs: palitra.lastUploadedAtTs,
    author: palitra.author,
    accessSummary: getAccessSummary(palitra, user, myScope, organisms, aors),
    canModify,
    canSelect:
      palitra.id >= 0 &&
      !archiveInFlight &&
      !deleteInFlight &&
      !downloadInFlight &&
      !uploadInFlight &&
      !retryInFlight,
    archiveInFlight,
    deleteInFlight,
    downloadInFlight,
    uploadInFlight,
    retryInFlight,
  };
}

export function buildTableRows(args: {
  palitras: Palitra[];
  folderPermissionPalitras?: Palitra[];
  user: User | null;
  myScope: MyScope | null;
  organisms: Organism[];
  aors: AreaOfResponsibility[];
  inFlightArchiveId: number | null;
  inFlightDeleteId: number | null;
  inFlightDownloadId: number | null;
  inFlightUploadId: number | null;
  inFlightRetryId: number | null;
  expandedFolderPaths: Set<string>;
}): TableRowView[] {
  const {
    palitras,
    folderPermissionPalitras,
    user,
    myScope,
    organisms,
    aors,
    inFlightArchiveId,
    inFlightDeleteId,
    inFlightDownloadId,
    inFlightUploadId,
    inFlightRetryId,
    expandedFolderPaths,
  } = args;
  const visibleFolderTree = buildFolderTree(palitras, user);
  const permissionFolderTree = buildFolderTree(folderPermissionPalitras ?? palitras, user);
  const nodesByPath = new Map(visibleFolderTree.map((node) => [node.path, node]));
  const permissionNodesByPath = new Map(permissionFolderTree.map((node) => [node.path, node]));
  const folderChildren = new Map<string, string[]>();

  for (const node of visibleFolderTree) {
    const parentPath = splitFolderPath(node.path).slice(0, -1).join('/');
    const current = folderChildren.get(parentPath) ?? [];
    current.push(node.path);
    folderChildren.set(parentPath, current);
  }

  for (const [path, childPaths] of folderChildren) {
    folderChildren.set(
      path,
      [...childPaths].sort((left, right) => left.localeCompare(right, 'uk')),
    );
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

  function appendFolder(path: string, parentExpanded: boolean) {
    const node = nodesByPath.get(path);
    if (!node) return;
    const permissionNode = permissionNodesByPath.get(path) ?? node;
    const folderRow = mapFolderNodeToRowView(node, expandedFolderPaths, !parentExpanded);
    folderRow.modifiableCount = permissionNode.modifiablePalitraIds.length;
    folderRow.canModify = permissionNode.modifiablePalitraIds.length > 0;
    rows.push(folderRow);

    const branchExpanded = parentExpanded && expandedFolderPaths.has(path);

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
          inFlightRetryId,
          depth: node.depth + 1,
          hiddenByCollapsedFolder: !branchExpanded,
        }),
      );
    }

    for (const childPath of folderChildren.get(path) ?? []) {
      appendFolder(childPath, branchExpanded);
    }
  }

  for (const rootFolderPath of folderChildren.get('') ?? []) {
    appendFolder(rootFolderPath, true);
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
        inFlightRetryId,
        depth: 0,
        hiddenByCollapsedFolder: false,
      }),
    );
  }

  return rows;
}

export function getSelectedModifiablePalitras(
  rows: PalitraRowView[],
  selectedIds: number[],
): Palitra[] {
  const selectedIdSet = new Set(selectedIds);
  return rows
    .filter((row) => selectedIdSet.has(row.id) && row.canSelect && row.canModify)
    .map((row) => row.palitra);
}

export function getSelectedDownloadablePalitras(
  rows: PalitraRowView[],
  selectedIds: number[],
): Palitra[] {
  const selectedIdSet = new Set(selectedIds);
  return rows.filter((row) => selectedIdSet.has(row.id) && row.canSelect).map((row) => row.palitra);
}
