import type { Palitra, User } from '../../../../Bindings';

import { canModifyPalitra } from './helpers-access';
import { FolderTableRowView, FolderTreeNode } from './types';

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
  // Flat folder semantics: treat the normalized value as a single segment.
  return normalizedPath === '' ? [] : [normalizedPath];
}

export function validateFolderPath(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === '') return 'Вкажіть назву папки.';
  // Flat UI only: slash is reserved and must not create nested folders here.
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

  const sortedPaths = [...folderPaths].sort(
    (left, right) => splitFolderPath(right).length - splitFolderPath(left).length,
  );

  for (const path of sortedPaths) {
    const node = folderNodes.get(path);
    if (!node) continue;

    const directPalitras = palitrasByFolder.get(path) ?? [];
    const directIds = directPalitras.map((palitra) => palitra.id);
    const directModifiableIds = directPalitras
      .filter((palitra) => canModifyPalitra(user, palitra))
      .map((palitra) => palitra.id);
    const childAllIds = node.childPaths.flatMap(
      (childPath) => folderNodes.get(childPath)?.allPalitraIds ?? [],
    );
    const childModifiableIds = node.childPaths.flatMap(
      (childPath) => folderNodes.get(childPath)?.modifiablePalitraIds ?? [],
    );

    node.childPaths = [...node.childPaths].sort((left, right) => left.localeCompare(right, 'uk'));
    node.directPalitraIds = [...new Set(directIds)].sort((left, right) => left - right);
    node.allPalitraIds = [...new Set([...directIds, ...childAllIds])].sort(
      (left, right) => left - right,
    );
    node.modifiablePalitraIds = [...new Set([...directModifiableIds, ...childModifiableIds])].sort(
      (left, right) => left - right,
    );
  }

  return Array.from(folderNodes.values()).sort((left, right) =>
    left.path.localeCompare(right.path, 'uk'),
  );
}

export function getFolderNodeByPath(tree: FolderTreeNode[], path: string): FolderTreeNode | null {
  const normalizedPath = normalizeFolderPathForUi(path);
  return tree.find((node) => node.path === normalizedPath) ?? null;
}

export function getExistingFolderOptions(tree: FolderTreeNode[]): string[] {
  return tree.map((node) => node.path).sort((left, right) => left.localeCompare(right, 'uk'));
}

export function mapFolderNodeToRowView(
  node: FolderTreeNode,
  expandedFolderPaths: Set<string>,
  hiddenByCollapsedFolder = false,
): FolderTableRowView {
  return {
    id: 'folder:' + node.path,
    kind: 'folder',
    folderPath: node.path,
    hiddenByCollapsedFolder,
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
    retryInFlight: false,
    colorHex: null,
    sourceFileName: null,
    lastUploadedAtTs: null,
    author: null,
    accessSummary: 'У папці: ' + String(node.allPalitraIds.length),
  };
}
