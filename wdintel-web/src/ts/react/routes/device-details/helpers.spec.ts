import { describe, expect, it } from 'vitest';

import {
  buildDeviceFilesListReq,
  fileDisplayName,
  formatAorLabel,
  formatUnitLabel,
  hasActiveFileFilters,
  mapDeviceDeletedFilter,
} from './helpers';

describe('device details helpers', () => {
  it('maps file deleted filters to backend enum values', () => {
    expect(mapDeviceDeletedFilter('active')).toBe('active_only');
    expect(mapDeviceDeletedFilter('deleted')).toBe('deleted_only');
    expect(mapDeviceDeletedFilter('all')).toBe('all');
  });

  it('builds file list requests with pagination', () => {
    expect(
      buildDeviceFilesListReq({
        deviceId: '018f0000-0000-7000-8000-000000000000',
        deletedFilter: 'deleted',
        limit: 50,
        offset: 100,
      }),
    ).toEqual({
      deviceId: '018f0000-0000-7000-8000-000000000000',
      deletedFilter: 'deleted_only',
      limit: 50,
      offset: 100,
    });
  });

  it('formats missing AOR/unit labels with id fallback', () => {
    expect(formatAorLabel(7, null)).toBe('AOR #7 — назва недоступна');
    expect(formatUnitLabel(8, '')).toBe('Підрозділ #8 — назва недоступна');
    expect(formatAorLabel(null, null)).toBe('—');
  });

  it('uses name, path, then id for file display names', () => {
    expect(
      fileDisplayName({
        fileId: 'file-id',
        deviceId: 'device-id',
        originalName: ' scan.pdf ',
        originalAbsolutePath: '/tmp/scan.pdf',
        originalCreatedAtMs: null,
        originalModifiedAtMs: null,
        deleted: false,
        createdAtMs: 10,
        updatedAtMs: 20,
        deletedAtMs: null,
      }),
    ).toBe('scan.pdf');

    expect(
      fileDisplayName({
        fileId: 'file-id',
        deviceId: 'device-id',
        originalName: ' ',
        originalAbsolutePath: '/tmp/scan.pdf',
        originalCreatedAtMs: null,
        originalModifiedAtMs: null,
        deleted: false,
        createdAtMs: 10,
        updatedAtMs: 20,
        deletedAtMs: null,
      }),
    ).toBe('/tmp/scan.pdf');
  });

  it('detects active file filters', () => {
    expect(hasActiveFileFilters('active')).toBe(false);
    expect(hasActiveFileFilters('deleted')).toBe(true);
    expect(hasActiveFileFilters('all')).toBe(true);
  });
});
