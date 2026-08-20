import type { Palitra } from '../../../../Bindings';

import { buildBulkActionResultSummary, formatFolderActionSuccessMessage } from './helpers';
import type { FolderActionDialogState, UiStatus } from './types';

export type ArchiveView = 'active' | 'all' | 'archived';

const VIEW_MODE_QUERY_PARAM = 'viewMode';

export function filterPalitrasByArchiveView(
  palitras: Palitra[],
  archiveView: ArchiveView,
): Palitra[] {
  switch (archiveView) {
    case 'archived':
      return palitras.filter((palitra) => palitra.isArchived);
    case 'all':
      return palitras;
    case 'active':
      return palitras.filter(
        (palitra) => !palitra.isArchived && palitra.conversionStatus !== 'error',
      );
  }
}

export function readInitialArchiveViewFromUrl(): ArchiveView {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  if (params.has('tab')) {
    params.delete('tab');
    const nextSearch = params.toString();
    window.history.replaceState(
      {},
      '',
      url.pathname + (nextSearch ? `?${nextSearch}` : '') + url.hash,
    );
  }
  const value = params.get(VIEW_MODE_QUERY_PARAM);
  if (value === 'all' || value === 'archived' || value === 'active') {
    return value;
  }
  return 'active';
}

export function updateArchiveViewInUrl(archiveView: ArchiveView) {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  params.delete('tab');

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
