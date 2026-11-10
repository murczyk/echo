import type {
  BrowseDeviceFilesReq,
  DeviceFileFilters,
  DeviceFileTreeEntry,
  SearchDeviceFilesReq,
} from '../../../../Bindings';
import { formatFileSize } from '../../components/attachment-files';
import { HttpRequestError } from '../../services/api/client';
import { formatDeviceErrorMessage } from '../devices/helpers';
import {
  DEVICE_FILE_PAGE_SIZE,
  type DeviceAnalyticsTagFilter,
  type DeviceFileLoadError,
  type DeviceFileSearchDraft,
  type DeviceFileSearchValidationErrors,
} from './types';

export function formatDeviceFileSize(size: number | null): string {
  if (size == null) return '—';
  return size === 0 ? '0 Б' : formatFileSize(size) || '—';
}

export function createDefaultFileSearchDraft(): DeviceFileSearchDraft {
  return {
    nameQuery: '',
    kinds: [],
    mimeTypes: '',
    extensions: '',
    modifiedFrom: null,
    modifiedTo: null,
  };
}

export function validateFileSearchDraft(
  draft: DeviceFileSearchDraft,
): DeviceFileSearchValidationErrors {
  const errors: DeviceFileSearchValidationErrors = {};
  const nameLength = Array.from(draft.nameQuery.trim()).length;
  if (nameLength > 0 && nameLength < 3) {
    errors.nameQuery = 'Введіть щонайменше 3 символи.';
  }
  if (
    draft.modifiedFrom !== null &&
    draft.modifiedTo !== null &&
    new Date(draft.modifiedFrom).getTime() > new Date(draft.modifiedTo).getTime()
  ) {
    errors.modifiedRange = 'Початок періоду має бути не пізніше завершення.';
  }
  return errors;
}

function splitFilterValues(value: string): string[] | null {
  const values = Array.from(
    new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  return values.length === 0 ? null : values;
}

export function buildBrowseDeviceFilesReq(params: {
  deviceId: string;
  syncId?: string | null;
  archiveRevision?: number | null;
  parentEntryId: string;
  cursor: string | null;
  tagFilter: DeviceAnalyticsTagFilter;
  filters?: DeviceFileFilters | null;
  hasContent?: BrowseDeviceFilesReq['hasContent'];
  sortBy?: BrowseDeviceFilesReq['sortBy'];
  sortDirection?: BrowseDeviceFilesReq['sortDirection'];
  includeBreadcrumbs?: boolean;
}): BrowseDeviceFilesReq {
  return {
    filters: params.filters ?? null,
    archiveRevision: params.archiveRevision ?? null,
    sortBy: params.sortBy ?? null,
    sortDirection: params.sortDirection ?? null,
    deviceId: params.deviceId,
    syncId: params.syncId ?? null,
    parentEntryId: params.parentEntryId,
    includeBreadcrumbs: params.includeBreadcrumbs ?? true,
    favoritesOnly: null,
    unviewedOnly: null,
    archiveFailed: null,
    archiveEncrypted: null,
    limit: DEVICE_FILE_PAGE_SIZE,
    cursor: params.cursor,
    hasContent: params.hasContent ?? null,
    tagIds: params.tagFilter.tagIds.length === 0 ? null : params.tagFilter.tagIds,
    tagMatch: params.tagFilter.tagIds.length === 0 ? null : params.tagFilter.tagMatch,
    untagged: params.tagFilter.untagged || null,
  };
}

export type DeviceFileSearchFilters = {
  listingFilters?: DeviceFileFilters | null;
  sortBy?: BrowseDeviceFilesReq['sortBy'];
  sortDirection?: BrowseDeviceFilesReq['sortDirection'];
  hasContent?: boolean | null;
  favoritesOnly?: boolean;
  unviewedOnly?: boolean;
  archiveFailed?: boolean;
  archiveEncrypted?: boolean;
};

export function buildSearchDeviceFilesReq(params: {
  deviceId: string;
  syncId?: string | null;
  scopeEntryId: string;
  archiveRevision?: number | null;
  draft: DeviceFileSearchDraft;
  filters?: DeviceFileSearchFilters;
  cursor: string | null;
  tagFilter: DeviceAnalyticsTagFilter;
}): SearchDeviceFilesReq {
  const nameQuery = params.draft.nameQuery.trim();
  return {
    filters: params.filters?.listingFilters ?? null,
    deviceId: params.deviceId,
    syncId: params.syncId ?? null,
    scopeEntryId: params.scopeEntryId,
    archiveRevision: params.draft.globalSearch ? null : (params.archiveRevision ?? null),
    globalSearch: params.draft.globalSearch ?? false,
    rankByRelevance: true,
    sortBy: params.filters?.sortBy ?? null,
    sortDirection: params.filters?.sortDirection ?? null,
    hasContent: params.filters?.hasContent ?? null,
    favoritesOnly: params.filters?.favoritesOnly || null,
    unviewedOnly: params.filters?.unviewedOnly || null,
    archiveFailed: params.filters?.archiveFailed || null,
    archiveEncrypted: params.filters?.archiveEncrypted || null,
    nameQuery: nameQuery === '' ? null : nameQuery,
    kinds: params.draft.kinds.length === 0 ? null : params.draft.kinds,
    mimeTypes: splitFilterValues(params.draft.mimeTypes),
    extensions: splitFilterValues(params.draft.extensions),
    fileMetadataModifiedFrom: params.draft.modifiedFrom,
    fileMetadataModifiedTo: params.draft.modifiedTo,
    limit: DEVICE_FILE_PAGE_SIZE,
    cursor: params.cursor,
    tagIds: params.tagFilter.tagIds.length === 0 ? null : params.tagFilter.tagIds,
    tagMatch: params.tagFilter.tagIds.length === 0 ? null : params.tagFilter.tagMatch,
    untagged: params.tagFilter.untagged || null,
  };
}

export function buildSearchFingerprint(
  deviceId: string,
  scopeEntryId: string,
  draft: DeviceFileSearchDraft,
  tagFilter: DeviceAnalyticsTagFilter,
  syncId: string | null = null,
  filters?: DeviceFileSearchFilters,
  archiveRevision: number | null = null,
): string {
  const req = buildSearchDeviceFilesReq({
    deviceId,
    syncId,
    scopeEntryId,
    archiveRevision,
    draft,
    filters,
    cursor: null,
    tagFilter,
  });
  return JSON.stringify(req);
}

export function appendDeviceFileEntries(
  current: DeviceFileTreeEntry[],
  incoming: DeviceFileTreeEntry[],
): DeviceFileTreeEntry[] {
  const knownEntryIds = new Set(current.map((entry) => entry.entryId));
  return [...current, ...incoming.filter((entry) => !knownEntryIds.has(entry.entryId))];
}

export function toDeviceFileLoadError(error: unknown, prefix: string): DeviceFileLoadError {
  return {
    message: `${prefix}: ${formatDeviceErrorMessage(error)}`,
    status: error instanceof HttpRequestError ? error.status : null,
  };
}

export function createDefaultDeviceFileFilters(): DeviceFileFilters {
  return {
    fileTypes: [],
    extensions: [],
    modifiedFrom: null,
    modifiedTo: null,
    hasContent: true,
    favoritesOnly: false,
    unviewedOnly: false,
    archiveFailed: false,
    archiveEncrypted: false,
    tagIds: [],
    tagMatch: 'any',
    untagged: false,
  };
}
