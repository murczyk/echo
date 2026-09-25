import { describe, expect, it } from 'vitest';

import type { DeviceFileTreeEntry } from '../../../../../Bindings';
import { appendDeviceFileEntries } from '../helpers';

const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const ENTRY_ID = '018f0000-0000-7000-8000-000000000002';
const FILE_ID = '018f0000-0000-7000-8000-000000000003';
const SYNC_ID = '018f0000-0000-7000-8000-000000000006';
const NOW = '2026-07-24T08:00:00Z';

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
