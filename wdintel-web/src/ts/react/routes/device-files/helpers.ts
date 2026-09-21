import type {
  BrowseDeviceFilesReq,
  DeviceFileTreeEntry,
  SearchDeviceFilesReq,
} from '../../../../Bindings';
import { HttpRequestError } from '../../services/api/client';
import { formatDeviceErrorMessage } from '../devices/helpers';
import {
  DEVICE_FILE_PAGE_SIZE,
  type DeviceAnalyticsTagFilter,
  type DeviceFileLoadError,
  type DeviceFileSearchDraft,
  type DeviceFileSearchValidationErrors,
} from './types';

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
  parentEntryId: string;
  cursor: string | null;
  tagFilter: DeviceAnalyticsTagFilter;
}): BrowseDeviceFilesReq {
  return {
    deviceId: params.deviceId,
    syncId: params.syncId ?? null,
    parentEntryId: params.parentEntryId,
    includeBreadcrumbs: true,
    limit: DEVICE_FILE_PAGE_SIZE,
    cursor: params.cursor,
    tagIds: params.tagFilter.tagIds.length === 0 ? null : params.tagFilter.tagIds,
    tagMatch: params.tagFilter.tagIds.length === 0 ? null : params.tagFilter.tagMatch,
    untagged: params.tagFilter.untagged || null,
  };
}

export function buildSearchDeviceFilesReq(params: {
  deviceId: string;
  syncId?: string | null;
  scopeEntryId: string;
  draft: DeviceFileSearchDraft;
  cursor: string | null;
  tagFilter: DeviceAnalyticsTagFilter;
}): SearchDeviceFilesReq {
  const nameQuery = params.draft.nameQuery.trim();
  return {
    deviceId: params.deviceId,
    syncId: params.syncId ?? null,
    scopeEntryId: params.scopeEntryId,
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
): string {
  const req = buildSearchDeviceFilesReq({
    deviceId,
    syncId,
    scopeEntryId,
    draft,
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
