import { describe, expect, it } from 'vitest';

import type {
  DeviceFile,
  DeviceFileRoot,
  DeviceFileTreeEntry,
  FileSyncErrorKind,
  SyncDeviceFilesRsp,
} from '../../../../Bindings';
import { HttpRequestError } from '../../services/api/client';
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
} from './helpers';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const ENTRY_ID = '018f0000-0000-7000-8000-000000000002';
const FILE_ID = '018f0000-0000-7000-8000-000000000003';
const NOW = '2026-07-24T08:00:00Z';

function buildEntry(overrides: Partial<DeviceFileTreeEntry> = {}): DeviceFileTreeEntry {
  return {
    entryId: ENTRY_ID,
    parentEntryId: ROOT_ID,
    kind: 'file',
    fileId: FILE_ID,
    name: 'звіт %.log',
    pathComponents: ['data', 'звіт %.log'],
    pathSyntax: 'posix',
    absolutePath: '/data/звіт %.log',
    hasContent: false,
    mimeType: 'text/plain',
    extension: 'log',
    fileMetadataCreatedAt: NOW,
    fileMetadataModifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildRoot(): DeviceFileRoot {
  return {
    entryId: ROOT_ID,
    deviceId: DEVICE_ID,
    parentEntryId: null,
    kind: 'directory',
    name: '/',
    pathSyntax: 'posix',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function buildFile(absolutePath = '/data/звіт %.log'): DeviceFile {
  return {
    fileId: FILE_ID,
    deviceId: DEVICE_ID,
    parentEntryId: ROOT_ID,
    rootEntryId: ROOT_ID,
    pathSyntax: 'posix',
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
  };
}

describe('device file request helpers', () => {
  it('builds direct-child browse requests without client path semantics', () => {
    expect(
      buildBrowseDeviceFilesReq({ deviceId: DEVICE_ID, parentEntryId: ROOT_ID, cursor: 'next' }),
    ).toEqual({
      deviceId: DEVICE_ID,
      parentEntryId: ROOT_ID,
      includeBreadcrumbs: true,
      limit: 100,
      cursor: 'next',
    });
  });

  it('preserves literal search characters and normalizes only filter lists', () => {
    const req = buildSearchDeviceFilesReq({
      deviceId: DEVICE_ID,
      scopeEntryId: ROOT_ID,
      cursor: null,
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

describe('device file sync helpers', () => {
  it.each([
    ['posix', '/дані/  звіт %.log'],
    ['windows', 'C:\\дані\\  звіт %.log'],
    ['windows', '\\\\server\\share\\дані\\звіт %.log'],
  ] as const)('preserves exact %s source paths', (pathSyntax, absolutePath) => {
    const row = createEmptyDeviceFileSyncRow();
    row.absolutePath = absolutePath;

    const { req } = buildSyncDeviceFilesReq({ deviceId: DEVICE_ID, pathSyntax, rows: [row] });

    expect(req.files[0].absolutePath).toBe(absolutePath);
    expect(req.files[0].fileId).toBeNull();
  });

  it('creates an existing-file row from canonical backend fields', () => {
    const row = createDeviceFileSyncRowFromEntry(buildEntry());

    expect(row).toMatchObject({
      fileId: FILE_ID,
      absolutePath: '/data/звіт %.log',
      mimeType: 'text/plain',
      extension: 'log',
    });
  });

  it('maps ordered accepted and rejected results to the frozen submit snapshot', () => {
    const acceptedRow = createEmptyDeviceFileSyncRow();
    acceptedRow.absolutePath = '/accepted.log';
    const rejectedRow = createEmptyDeviceFileSyncRow();
    rejectedRow.absolutePath = '/rejected.log';
    const submittedRowIds = [acceptedRow.localId, rejectedRow.localId];
    const rsp: SyncDeviceFilesRsp = {
      results: [
        {
          Rejected: {
            index: 1,
            error: {
              kind: 'conflict',
              message: 'conflict',
              fieldErrors: [['files[1].absolute_path', 'already exists']],
            },
          },
        },
        {
          Accepted: {
            index: 0,
            operation: 'created',
            root: buildRoot(),
            file: buildFile('/accepted.log'),
          },
        },
      ],
    };

    const rows = applySyncDeviceFilesRsp([acceptedRow, rejectedRow], submittedRowIds, rsp);

    expect(rows[0].result).toMatchObject({ kind: 'accepted', operation: 'created' });
    expect(rows[1].result).toMatchObject({ kind: 'rejected' });
    expect(rows[1].fieldErrors.absolutePath).toBe('already exists');
    expect(
      buildSyncDeviceFilesReq({ deviceId: DEVICE_ID, pathSyntax: 'posix', rows }).submittedRowIds,
    ).toEqual([rejectedRow.localId]);
  });

  it.each<FileSyncErrorKind>(['validation', 'not_found', 'conflict', 'dependency', 'internal'])(
    'preserves %s rejection kinds',
    (kind) => {
      const row = createEmptyDeviceFileSyncRow();
      const rows = applySyncDeviceFilesRsp([row], [row.localId], {
        results: [{ Rejected: { index: 0, error: { kind, message: kind, fieldErrors: [] } } }],
      });
      expect(rows[0].result).toEqual({
        kind: 'rejected',
        error: { kind, message: kind, fieldErrors: [] },
      });
    },
  );

  it('binds top-level field errors and marks only transport failures uncertain', () => {
    const row = createEmptyDeviceFileSyncRow();
    const requestError = parseSyncRequestError(
      new HttpRequestError(
        400,
        JSON.stringify([
          ['path_syntax', 'invalid syntax'],
          ['files[0].absolute_path', 'invalid path'],
        ]),
      ),
      [row.localId],
    );
    expect(requestError.batchError).toBe('invalid syntax');
    expect(requestError.rowErrors.get(row.localId)?.absolutePath).toBe('invalid path');
    expect(requestError.transportUncertain).toBe(false);

    const transportError = parseSyncRequestError(new HttpRequestError(0, 'network down'), [
      row.localId,
    ]);
    expect(transportError.transportUncertain).toBe(true);
    expect(transportError.batchError).toContain('Результат запиту невідомий');
  });
});
