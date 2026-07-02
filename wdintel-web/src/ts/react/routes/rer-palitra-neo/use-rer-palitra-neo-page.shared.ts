import { buildBulkActionResultSummary, formatFolderActionSuccessMessage } from './helpers';
import type { FolderActionDialogState, UiStatus } from './types';

export type ArchiveView = 'active' | 'all' | 'archived';

const VIEW_MODE_QUERY_PARAM = 'viewMode';

export function readInitialArchiveViewFromUrl(): ArchiveView {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(VIEW_MODE_QUERY_PARAM);
  if (value === 'all' || value === 'archived' || value === 'active') {
    return value;
  }
  return 'active';
}

export function updateArchiveViewInUrl(archiveView: ArchiveView) {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);

  if (archiveView === 'active') {
    params.delete(VIEW_MODE_QUERY_PARAM);
  } else {
    params.set(VIEW_MODE_QUERY_PARAM, archiveView);
  }

  const nextSearch = params.toString();
  const nextUrl = url.pathname + (nextSearch ? '?' + nextSearch : '') + url.hash;
  window.history.replaceState({}, '', nextUrl);
}

export function buildFolderActionStatus(
  state: FolderActionDialogState,
  changedIds: number[],
): UiStatus {
  const summary = buildBulkActionResultSummary(state.preview.requestedIds, changedIds);
  const text = formatFolderActionSuccessMessage(state.kind, summary);

  if (summary.changedCount === 0) {
    return { kind: 'warning', text };
  }

  if (
    state.preview.skippedCount > 0 ||
    state.preview.unchangedCount > 0 ||
    summary.skippedCount > 0
  ) {
    return { kind: 'warning', text };
  }

  return { kind: 'success', text };
}
