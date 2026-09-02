import { describe, expect, it } from 'vitest';

import type {
  DeviceFile,
  DeviceFileTreeEntry,
  FileSyncErrorCode,
  SyncDeviceFilesRsp,
  SyncSummary,
} from '../../../../../Bindings';
import { HttpRequestError } from '../../../services/api/client';
import {
  appendDeviceFileEntries,
  applySyncDeviceFilesRsp,
  buildBrowseDeviceFilesReq,
  buildSearchDeviceFilesReq,
  buildSyncDeviceFilesReq,
  createDefaultFileSearchDraft,
  createDeviceFileSyncRowFromEntry,
  createEmptyDeviceFileSyncRow,
  parseSyncRequestError,
  validateFileSearchDraft,
} from '../helpers';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const ENTRY_ID = '018f0000-0000-7000-8000-000000000002';
const FILE_ID = '018f0000-0000-7000-8000-000000000003';
const SYNC_ID = '018f0000-0000-7000-8000-000000000006';
const NOW = '2026-07-24T08:00:00Z';
const EMPTY_TAG_FILTER = { tagIds: [], tagMatch: 'any' as const, untagged: false };

function buildEntry(overrides: Partial<DeviceFileTreeEntry> = {}): DeviceFileTreeEntry {
  return {
    entryId: ENTRY_ID,
    parentEntryId: ROOT_ID,
    kind: 'file',
    fileId: FILE_ID,
    name: 'звіт %.log',
    pathComponents: ['data', 'звіт %.log'],
    absolutePath: 'C:\\data\\звіт %.log',
    hasContent: false,
    mimeType: 'text/plain',
    extension: 'log',
    fileMetadataCreatedAt: NOW,
    fileMetadataModifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 3,
    syncId: SYNC_ID,
    sourceFileState: {
      state: 'downloaded',
      settledAt: NOW,
      settledBy: 'device-source',
    },
    tags: [],
    ...overrides,
  };
}

function buildFile(absolutePath = 'C:\\data\\звіт %.log'): DeviceFile {
  return {
    fileId: FILE_ID,
    deviceId: DEVICE_ID,
    parentEntryId: ROOT_ID,
    rootEntryId: ROOT_ID,
    absolutePath,
    hasContent: false,
    name: 'звіт %.log',
    pathComponents: ['data', 'звіт %.log'],
    mimeType: 'text/plain',
    extension: 'log',
    fileMetadataCreatedAt: NOW,
    fileMetadataModifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    revision: 4,
    syncId: SYNC_ID,
    sourceFileState: null,
    tags: [],
  };
}

function buildSyncSummary(overrides: Partial<SyncSummary> = {}): SyncSummary {
  return {
    syncId: SYNC_ID,
    deviceId: DEVICE_ID,
    mode: 'automatic',
    status: 'completed_with_errors',
    nextBatchIndex: 1,
    counts: {
      received: 2,
      accepted: 1,
      created: 1,
      updated: 0,
      rejected: 1,
    },
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
    expiresAt: null,
    ...overrides,
  };
}
// @test-scope parser: preserves device-file request mapping and legacy response normalization.
describe('device file request helpers', () => {
  it('builds direct-child browse requests without client path semantics', () => {
    expect(
      buildBrowseDeviceFilesReq({
        deviceId: DEVICE_ID,
        parentEntryId: ROOT_ID,

        cursor: 'next',
        tagFilter: EMPTY_TAG_FILTER,
      }),
    ).toEqual({
      deviceId: DEVICE_ID,
      parentEntryId: ROOT_ID,
      includeBreadcrumbs: true,
      limit: 100,
      cursor: 'next',
      tagIds: null,
      tagMatch: null,
      untagged: null,
    });
  });

  it('preserves literal search characters and normalizes only filter lists', () => {
    const req = buildSearchDeviceFilesReq({
      deviceId: DEVICE_ID,
      scopeEntryId: ROOT_ID,
      cursor: null,
      tagFilter: EMPTY_TAG_FILTER,
      draft: {
        ...createDefaultFileSearchDraft(),
        nameQuery: '  %_\\  ',
        kinds: ['file'],
        mimeTypes: ' text/plain, application/json\ntext/plain ',
        extensions: ' log, JSON ',
        modifiedFrom: '2026-07-01T00:00:00.000Z',
        modifiedTo: '2026-07-31T00:00:00.000Z',
      },
    });

    expect(req).toMatchObject({
      nameQuery: '%_\\',
      kinds: ['file'],
      mimeTypes: ['text/plain', 'application/json'],
      extensions: ['log', 'JSON'],
      scopeEntryId: ROOT_ID,
      cursor: null,
    });
  });

  it('validates query length and date ordering before search', () => {
    expect(
      validateFileSearchDraft({
        ...createDefaultFileSearchDraft(),
        nameQuery: 'аб',
        modifiedFrom: '2026-07-31T00:00:00.000Z',
        modifiedTo: '2026-07-01T00:00:00.000Z',
      }),
    ).toEqual({
      nameQuery: 'Введіть щонайменше 3 символи.',
      modifiedRange: 'Початок періоду має бути не пізніше завершення.',
    });
  });

  it('keeps distinct duplicate paths and rejects only repeated entry IDs on append', () => {
    const first = buildEntry();
    const duplicatePath = buildEntry({
      entryId: '018f0000-0000-7000-8000-000000000004',
      fileId: '018f0000-0000-7000-8000-000000000005',
    });

    expect(appendDeviceFileEntries([first], [duplicatePath, first])).toEqual([
      first,
      duplicatePath,
    ]);
  });
});

// @test-scope safeguard: prevents failed device-file sync state from reporting a completed file refresh.
describe('device file sync helpers', () => {
  it.each(['C:\\дані\\  звіт %.log', '\\\\server\\share\\дані\\звіт %.log'] as const)(
    'preserves exact Windows source path %s',
    (absolutePath) => {
      const row = createEmptyDeviceFileSyncRow();
      row.absolutePath = absolutePath;

      const { req } = buildSyncDeviceFilesReq({ deviceId: DEVICE_ID, rows: [row] });

      expect(req.files[0].absolutePath).toBe(absolutePath);
      expect(req.files[0]).not.toHaveProperty('fileId');
      expect(req.files[0].sourceFileState).toBeNull();
    },
  );

  it('creates an existing-file row from canonical backend fields', () => {
    const row = createDeviceFileSyncRowFromEntry(buildEntry());

    expect(row).toMatchObject({
      existing: true,
      absolutePath: 'C:\\data\\звіт %.log',
      mimeType: 'text/plain',
      extension: 'log',
      sourceFileState: {
        state: 'downloaded',
        settledBy: 'device-source',
      },
    });
    expect(
      buildSyncDeviceFilesReq({ deviceId: DEVICE_ID, rows: [row] }).req.files[0].sourceFileState,
    ).toEqual(buildEntry().sourceFileState);
  });

  it('maps ordered accepted and rejected results to the frozen submit snapshot', () => {
    const acceptedRow = createEmptyDeviceFileSyncRow();
    acceptedRow.absolutePath = 'C:\\accepted.log';
    const rejectedRow = createEmptyDeviceFileSyncRow();
    rejectedRow.absolutePath = 'C:\\rejected.log';
    const submittedRowIds = [acceptedRow.localId, rejectedRow.localId];
    const rsp: SyncDeviceFilesRsp = {
      sync: buildSyncSummary(),
      results: [
        {
          Rejected: {
            index: 1,
            code: 'validation',
            message: 'conflict',
            fieldErrors: [{ path: 'files[1].absolute_path', message: 'already exists' }],
          },
        },
        {
          Accepted: {
            index: 0,
            operation: 'created',
            fileId: FILE_ID,
            revision: 4,
            file: buildFile('C:\\accepted.log'),
          },
        },
      ],
    };

    const rows = applySyncDeviceFilesRsp([acceptedRow, rejectedRow], submittedRowIds, rsp);

    expect(rows[0].result).toMatchObject({ kind: 'accepted', operation: 'created' });
    expect(rows[1].result).toMatchObject({ kind: 'rejected' });
    expect(rows[1].fieldErrors.absolutePath).toBe('already exists');
    expect(buildSyncDeviceFilesReq({ deviceId: DEVICE_ID, rows }).submittedRowIds).toEqual([
      rejectedRow.localId,
    ]);
  });

  it.each<FileSyncErrorCode>(['validation', 'duplicate_path_in_session'])(
    'preserves %s rejection codes',
    (code) => {
      const row = createEmptyDeviceFileSyncRow();
      const rows = applySyncDeviceFilesRsp([row], [row.localId], {
        sync: buildSyncSummary(),
        results: [
          {
            Rejected: {
              index: 0,
              code,
              message: code,
              fieldErrors: [],
            },
          },
        ],
      });
      expect(rows[0].result).toEqual({
        kind: 'rejected',
        code,
        message: code,
        fieldErrors: [],
      });
    },
  );

  it('binds top-level field errors and marks only transport failures uncertain', () => {
    const row = createEmptyDeviceFileSyncRow();
    const requestError = parseSyncRequestError(
      new HttpRequestError(
        400,
        JSON.stringify([{ path: 'files[0].absolute_path', message: 'invalid path' }]),
      ),
      [row.localId],
    );
    expect(requestError.batchError).toBe('Виправте помилки в рядках батча.');
    expect(requestError.rowErrors.get(row.localId)?.absolutePath).toBe('invalid path');
    expect(requestError.transportUncertain).toBe(false);

    const transportError = parseSyncRequestError(new HttpRequestError(0, 'network down'), [
      row.localId,
    ]);
    expect(transportError.transportUncertain).toBe(true);
    expect(transportError.batchError).toContain('Результат запиту невідомий');
  });
});
