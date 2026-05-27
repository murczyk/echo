import { normalizeFolderPathForUi } from './helpers-folders';
import { FolderActionDialogState, FolderActionKind, FolderActionPreview, FolderActionResultSummary, FolderTreeNode, PalitraRowView } from './types';

export function buildAssignFolderPreview(
  rows: PalitraRowView[],
  selectedIds: number[],
  folderPath: string,
): FolderActionPreview {
  const normalizedPath = normalizeFolderPathForUi(folderPath);
  const selectedIdSet = new Set(selectedIds);
  const requestedIds = rows.filter((row) => selectedIdSet.has(row.id)).map((row) => row.id);
  const modifiableRows = rows.filter((row) => selectedIdSet.has(row.id) && row.canSelect && row.canModify);
  const modifiableIds = modifiableRows.map((row) => row.id);
  const modifiableIdSet = new Set(modifiableIds);
  const skippedIds = requestedIds.filter((id) => !modifiableIdSet.has(id));
  const unchangedIds =
    normalizedPath === ''
      ? []
      : modifiableRows
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
  const labels: Record<FolderActionKind, string> = {
    assign: 'Палітри переміщено в папку',
    rename: 'Папку перейменовано',
    archive: 'Архівовано палітри з папки',
    delete: 'Видалено палітри з папки',
  };
  const label = labels[kind];

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
