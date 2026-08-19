import type {
  BrowseDeviceFilesReq,
  DeviceFileTreeEntry,
  SearchDeviceFilesReq,
  SyncDeviceFilesReq,
  SyncDeviceFilesRsp,
} from '../../../../Bindings';
import { HttpRequestError } from '../../services/api/client';
import { formatDeviceErrorMessage } from '../devices/helpers';
import {
  DEVICE_FILE_PAGE_SIZE,
  type DeviceAnalyticsTagFilter,
  type DeviceFileLoadError,
  type DeviceFileSearchDraft,
  type DeviceFileSearchValidationErrors,
  type DeviceFileSyncField,
  type DeviceFileSyncResult,
  type DeviceFileSyncRow,
} from './types';

let nextSyncRowId = 0;

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
  parentEntryId: string;
  cursor: string | null;
  tagFilter: DeviceAnalyticsTagFilter;
}): BrowseDeviceFilesReq {
  return {
    deviceId: params.deviceId,
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
  scopeEntryId: string;
  draft: DeviceFileSearchDraft;
  cursor: string | null;
  tagFilter: DeviceAnalyticsTagFilter;
}): SearchDeviceFilesReq {
  const nameQuery = params.draft.nameQuery.trim();
  return {
    deviceId: params.deviceId,
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
): string {
  const req = buildSearchDeviceFilesReq({
    deviceId,
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

function createLocalSyncRowId(): string {
  nextSyncRowId += 1;
  return `device-file-sync-row-${nextSyncRowId}`;
}

export function createEmptyDeviceFileSyncRow(): DeviceFileSyncRow {
  return {
    localId: createLocalSyncRowId(),
    existing: false,
    absolutePath: '',
    mimeType: '',
    extension: '',
    fileMetadataCreatedAt: null,
    fileMetadataModifiedAt: null,
    sourceFileState: null,
    fieldErrors: {},
    result: null,
  };
}

export function createDeviceFileSyncRowFromEntry(entry: DeviceFileTreeEntry): DeviceFileSyncRow {
  return {
    localId: createLocalSyncRowId(),
    existing: true,
    absolutePath: entry.absolutePath ?? '',
    mimeType: entry.mimeType ?? '',
    extension: entry.extension ?? '',
    fileMetadataCreatedAt: entry.fileMetadataCreatedAt,
    fileMetadataModifiedAt: entry.fileMetadataModifiedAt,
    sourceFileState: entry.sourceFileState,
    fieldErrors: {},
    result: null,
  };
}

function emptyToNull(value: string): string | null {
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

export function buildSyncDeviceFilesReq(params: { deviceId: string; rows: DeviceFileSyncRow[] }): {
  req: SyncDeviceFilesReq;
  submittedRowIds: string[];
} {
  const submittedRows = params.rows.filter((row) => row.result?.kind !== 'accepted');
  return {
    req: {
      deviceId: params.deviceId,
      files: submittedRows.map((row) => ({
        absolutePath: row.absolutePath,
        mimeType: emptyToNull(row.mimeType),
        extension: emptyToNull(row.extension),
        fileMetadataCreatedAt: row.fileMetadataCreatedAt,
        fileMetadataModifiedAt: row.fileMetadataModifiedAt,
        sourceFileState: row.sourceFileState,
      })),
    },
    submittedRowIds: submittedRows.map((row) => row.localId),
  };
}

const syncFieldByServerName: Record<string, DeviceFileSyncField> = {
  absolute_path: 'absolutePath',
  mime_type: 'mimeType',
  extension: 'extension',
  file_metadata_created_at: 'fileMetadataCreatedAt',
  file_metadata_modified_at: 'fileMetadataModifiedAt',
};

function mapSyncFieldErrors(
  fieldErrors: Array<{ path: string; message: string }>,
  submittedRowIds: string[],
): Map<string, Partial<Record<DeviceFileSyncField, string>>> {
  const result = new Map<string, Partial<Record<DeviceFileSyncField, string>>>();
  for (const { path, message } of fieldErrors) {
    const match = /^files\[(\d+)]\.([a-z_]+)$/.exec(path);
    if (match === null) continue;
    const rowId = submittedRowIds[Number(match[1])];
    const field = syncFieldByServerName[match[2]];
    if (rowId === undefined || field === undefined) continue;
    result.set(rowId, { ...result.get(rowId), [field]: message });
  }
  return result;
}

export function applySyncDeviceFilesRsp(
  rows: DeviceFileSyncRow[],
  submittedRowIds: string[],
  rsp: SyncDeviceFilesRsp,
): DeviceFileSyncRow[] {
  const resultByRowId = new Map<string, NonNullable<DeviceFileSyncRow['result']>>();
  const fieldErrorsByRowId = new Map<string, Partial<Record<DeviceFileSyncField, string>>>();

  for (const result of rsp.results) {
    if ('Accepted' in result) {
      const rowId = submittedRowIds[result.Accepted.index];
      if (rowId !== undefined) {
        resultByRowId.set(rowId, {
          kind: 'accepted',
          operation: result.Accepted.operation,
          fileId: result.Accepted.fileId,
          revision: result.Accepted.revision,
          file: result.Accepted.file,
        });
      }
      continue;
    }

    const rowId = submittedRowIds[result.Rejected.index];
    if (rowId === undefined) continue;
    resultByRowId.set(rowId, {
      kind: 'rejected',
      code: result.Rejected.code,
      message: result.Rejected.message,
      fieldErrors: result.Rejected.fieldErrors,
    });
    const mappedErrors = mapSyncFieldErrors(result.Rejected.fieldErrors, submittedRowIds).get(
      rowId,
    );
    if (mappedErrors !== undefined) fieldErrorsByRowId.set(rowId, mappedErrors);
  }

  return rows.map((row) => ({
    ...row,
    fieldErrors: fieldErrorsByRowId.get(row.localId) ?? {},
    result: resultByRowId.get(row.localId) ?? row.result,
  }));
}

function parseFieldErrorPayload(message: string): Array<{ path: string; message: string }> {
  try {
    const payload: unknown = JSON.parse(message);
    if (!Array.isArray(payload)) return [];
    return payload.filter(
      (item): item is { path: string; message: string } =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).path === 'string' &&
        typeof (item as Record<string, unknown>).message === 'string',
    );
  } catch {
    return [];
  }
}

export function parseSyncRequestError(
  error: unknown,
  submittedRowIds: string[],
): {
  batchError: string;
  rowErrors: Map<string, Partial<Record<DeviceFileSyncField, string>>>;
  transportUncertain: boolean;
} {
  const message = formatDeviceErrorMessage(error);
  const fieldErrors = error instanceof Error ? parseFieldErrorPayload(error.message) : [];
  const rowErrors = mapSyncFieldErrors(fieldErrors, submittedRowIds);
  const transportUncertain = !(error instanceof HttpRequestError) || error.status === 0;
  const batchError = rowErrors.size > 0 ? 'Виправте помилки в рядках батча.' : message;
  return {
    batchError: transportUncertain
      ? `${message} Результат запиту невідомий: перевірте список файлів перед повторною відправкою.`
      : batchError,
    rowErrors,
    transportUncertain,
  };
}

export function updateSyncRowField(
  row: DeviceFileSyncRow,
  field: DeviceFileSyncField,
  value: string | null,
): DeviceFileSyncRow {
  return {
    ...row,
    [field]: value,
    fieldErrors: { ...row.fieldErrors, [field]: undefined },
    result: row.result?.kind === 'rejected' ? null : row.result,
  };
}

export function formatSyncOperation(operation: string): string {
  switch (operation) {
    case 'created':
      return 'Створено';
    case 'updated':
      return 'Оновлено';
    default:
      return operation;
  }
}

export function formatFileSyncError(
  error: Extract<DeviceFileSyncResult, { kind: 'rejected' }>,
): string {
  return `${error.code}: ${error.message}`;
}
