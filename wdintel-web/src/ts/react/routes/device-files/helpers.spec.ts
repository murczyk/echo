import { describe, expect, it } from 'vitest';

import type { DeviceFileTreeEntry } from '../../../../Bindings';
import {
  appendDeviceFileEntries,
  buildBrowseDeviceFilesReq,
  buildSearchDeviceFilesReq,
  createDefaultFileSearchDraft,
  validateFileSearchDraft,
} from './helpers';

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
