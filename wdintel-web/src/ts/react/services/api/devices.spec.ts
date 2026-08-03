/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  browseDeviceFiles,
  countDeviceFileSubtrees,
  createDevice,
  getDeviceDetail,
  getDeviceUnitStats,
  listDeviceAors,
  listDeviceUnits,
  journalDeviceFiles,
  listDeviceFileRoots,
  listDevices,
  searchDeviceFiles,
  syncDeviceFiles,
  toDeviceUpdatePatchReq,
  updateDevice,
} from './devices';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const ENTRY_ID = '018f0000-0000-7000-8000-000000000002';
const FILE_ID = '018f0000-0000-7000-8000-000000000003';
const CREATED_AT = '2026-07-24T06:00:00Z';
const UPDATED_AT = '2026-07-24T07:00:00Z';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchMock() {
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

function requestBody(index = 0) {
  const init = fetchMock().mock.calls[index][1] as RequestInit;
  if (init.body === undefined) return undefined;
  return JSON.parse(String(init.body));
}

function requestSignal(index = 0) {
  const init = fetchMock().mock.calls[index][1] as RequestInit;
  return init.signal;
}

function mockDeviceDetailsResponse() {
  return {
    id: DEVICE_ID,
    name: 'Device Alpha',
    aors: [{ id: 4, name: 'AOR' }],
    unit: { id: 7, name: 'Unit' },
    external_url: 'https://example.test/device',
    custom_fields: { inventory_id: 'node-1' },
    created_by: 'operator',
    archived: false,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    archived_at: null,
  };
}

function mockRootResponse() {
  return {
    entry_id: ROOT_ID,
    device_id: DEVICE_ID,
    parent_entry_id: null,
    kind: 'directory',
    name: '/',
    path_syntax: 'posix',
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  };
}

function mockFileResponse() {
  return {
    file_id: FILE_ID,
    device_id: DEVICE_ID,
    parent_entry_id: ROOT_ID,
    root_entry_id: ROOT_ID,
    path_syntax: 'posix',
    absolute_path: '/report.log',
    has_content: false,
    name: 'report.log',
    path_components: ['report.log'],
    mime_type: 'text/plain',
    extension: 'log',
    file_metadata_created_at: CREATED_AT,
    file_metadata_modified_at: UPDATED_AT,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(mockDeviceDetailsResponse())));
});

describe('devices API service routes', () => {
  it('lists devices using only the target request and response fields', async () => {
    const controller = new AbortController();
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        list: [
          {
            id: DEVICE_ID,
            name: 'Device Alpha',
            aors: [{ id: 4, name: 'AOR' }],
            unit: { id: 7, name: 'Unit' },
            created_by: 'operator',
            archived: false,
            created_at: CREATED_AT,
            updated_at: UPDATED_AT,
            archived_at: null,
          },
        ],
        total: 1,
        has_more: false,
        status_counts: { active: 3, archived: 1 },
      }),
    );

    const rsp = await listDevices(
      {
        filterText: 'alpha',
        archivedFilter: 'active_only',
        aorIds: [4],
        unitIds: [7],
        limit: 25,
        offset: 0,
        sortBy: ['updated_at_desc'],
      },
      { signal: controller.signal },
    );

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/list', expect.any(Object));
    expect(requestSignal()).toBe(controller.signal);
    expect(requestBody()).toEqual({
      filter_text: 'alpha',
      archived_filter: 'active_only',
      aor_ids: [4],
      unit_ids: [7],
      limit: 25,
      offset: 0,
      sort_by: ['updated_at_desc'],
    });
    expect(rsp.list[0]).toMatchObject({
      name: 'Device Alpha',
      aors: [{ id: 4, name: 'AOR' }],
      unit: { id: 7, name: 'Unit' },
      updatedAt: UPDATED_AT,
    });
    expect(rsp.statusCounts).toEqual({ active: 3, archived: 1 });
  });

  it('loads nested unit statistics without a request body', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ units: [{ unit: { id: 7, name: 'Unit' }, count: 3 }] }),
    );

    const rsp = await getDeviceUnitStats();

    expect(requestBody()).toBeUndefined();
    expect(rsp).toEqual([{ unit: { id: 7, name: 'Unit' }, count: 3 }]);
  });

  it('loads device-authorized AOR and unit lookups without request bodies', async () => {
    fetchMock()
      .mockResolvedValueOnce(jsonResponse([{ id: 4, name: 'AOR', is_top_level: true }]))
      .mockResolvedValueOnce(
        jsonResponse({
          units: [{ id: 7, name: 'Unit', created_by_login_id: 'analyst' }],
        }),
      );

    const aors = await listDeviceAors();
    const units = await listDeviceUnits();

    expect(fetchMock()).toHaveBeenNthCalledWith(1, '/api/device/aors', expect.any(Object));
    expect(fetchMock()).toHaveBeenNthCalledWith(2, '/api/device/units', expect.any(Object));
    expect(requestBody(0)).toBeUndefined();
    expect(requestBody(1)).toBeUndefined();
    expect(aors[0]).toMatchObject({ id: 4, name: 'AOR', isTopLevel: true });
    expect(units[0]).toMatchObject({ id: 7, name: 'Unit', createdByLoginId: 'analyst' });
  });

  it('normalizes details while preserving arbitrary custom-field keys', async () => {
    const rsp = await getDeviceDetail({ deviceId: DEVICE_ID, includeArchived: true });

    expect(requestBody()).toEqual({ device_id: DEVICE_ID, include_archived: true });
    expect(rsp.createdAt).toBe(CREATED_AT);
    expect(rsp.aors).toEqual([{ id: 4, name: 'AOR' }]);
    expect(rsp.customFields).toEqual({ inventory_id: 'node-1' });
  });

  it('creates a device with its permitted source and name fields', async () => {
    await createDevice({
      name: 'Device Alpha',
      externalUrl: null,
      customFields: { inventory_id: 'node-1' },
    });

    expect(requestBody()).toEqual({
      name: 'Device Alpha',
      external_url: null,
      custom_fields: { inventory_id: 'node-1' },
    });
  });

  it('serializes a presence-aware update without changing custom-field keys', async () => {
    await updateDevice({
      deviceId: DEVICE_ID,
      name: 'Renamed device',
      aorIds: [],
      unitId: null,
      customFields: { inventory_id: null, transportType: 'ssh' },
    });

    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      name: 'Renamed device',
      aor_ids: [],
      unit_id: null,
      custom_fields: { inventory_id: null, transportType: 'ssh' },
    });
  });
});

describe('device filesystem API service routes', () => {
  it('loads roots and transforms canonical root fields', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ roots: [mockRootResponse()] }));

    const rsp = await listDeviceFileRoots({ deviceId: DEVICE_ID });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/files/roots', expect.any(Object));
    expect(requestBody()).toEqual({ device_id: DEVICE_ID });
    expect(rsp.roots[0]).toMatchObject({
      entryId: ROOT_ID,
      pathSyntax: 'posix',
    });
  });
  it('loads subtree counts separately from tree payloads', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        counts: [{ entry_id: ROOT_ID, file_count: 12_345 }],
      }),
    );

    const rsp = await countDeviceFileSubtrees({
      deviceId: DEVICE_ID,
      parentEntryId: null,
      directoryEntryIds: [ROOT_ID],
    });

    expect(fetchMock()).toHaveBeenCalledWith(
      '/api/device/files/subtree-counts',
      expect.any(Object),
    );
    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      parent_entry_id: null,
      directory_entry_ids: [ROOT_ID],
    });
    expect(rsp.counts).toEqual([{ entryId: ROOT_ID, fileCount: 12_345 }]);
  });

  it('browses a directory with keyset pagination', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        breadcrumbs: [{ entry_id: ROOT_ID, name: '/' }],
        entries: [
          {
            entry_id: ENTRY_ID,
            parent_entry_id: ROOT_ID,
            kind: 'file',
            file_id: FILE_ID,
            name: 'report.log',
            path_components: ['report.log'],
            path_syntax: 'posix',
            absolute_path: '/report.log',
            has_content: true,
            mime_type: 'text/plain',
            extension: 'log',
            file_metadata_created_at: CREATED_AT,
            file_metadata_modified_at: UPDATED_AT,
            created_at: CREATED_AT,
            updated_at: UPDATED_AT,
          },
        ],
        next_cursor: 'next',
      }),
    );

    const rsp = await browseDeviceFiles({
      deviceId: DEVICE_ID,
      parentEntryId: ROOT_ID,
      includeBreadcrumbs: true,
      limit: 25,
      cursor: null,
    });

    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      parent_entry_id: ROOT_ID,
      include_breadcrumbs: true,
      limit: 25,
      cursor: null,
    });
    expect(rsp.entries[0].fileId).toBe(FILE_ID);
    expect(rsp.entries[0].hasContent).toBe(true);
    expect(rsp.nextCursor).toBe('next');
  });

  it('searches a subtree with canonical filters', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ entries: [], next_cursor: null }));

    await searchDeviceFiles({
      deviceId: DEVICE_ID,
      scopeEntryId: ROOT_ID,
      nameQuery: 'log',
      kinds: ['file'],
      mimeTypes: ['text/plain'],
      extensions: ['log'],
      fileMetadataModifiedFrom: CREATED_AT,
      fileMetadataModifiedTo: UPDATED_AT,
      limit: 10,
      cursor: null,
    });

    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      scope_entry_id: ROOT_ID,
      name_query: 'log',
      kinds: ['file'],
      mime_types: ['text/plain'],
      extensions: ['log'],
      file_metadata_modified_from: CREATED_AT,
      file_metadata_modified_to: UPDATED_AT,
      limit: 10,
      cursor: null,
    });
  });

  it('loads the device-wide synchronization journal with keyset pagination', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        entries: [
          {
            file_id: FILE_ID,
            name: 'report.log',
            absolute_path: '/report.log',
            has_content: true,
            synchronized_at: UPDATED_AT,
          },
        ],
        total_count: 12_345,
        next_cursor: 'next',
      }),
    );

    const rsp = await journalDeviceFiles({
      deviceId: DEVICE_ID,
      limit: 100,
      cursor: null,
    });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/files/journal', expect.any(Object));
    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      limit: 100,
      cursor: null,
    });
    expect(rsp).toEqual({
      entries: [
        {
          fileId: FILE_ID,
          name: 'report.log',
          absolutePath: '/report.log',
          hasContent: true,
          synchronizedAt: UPDATED_AT,
        },
      ],
      totalCount: 12_345,
      nextCursor: 'next',
    });
  });

  it('omits a create file_id and normalizes tagged sync outcomes', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            status: 'accepted',
            index: 0,
            operation: 'created',
            root: mockRootResponse(),
            file: mockFileResponse(),
          },
          {
            status: 'rejected',
            index: 1,
            error: {
              kind: 'validation',
              message: 'filesystem validation failed',
              field_errors: [['files[1].absolute_path', 'invalid']],
            },
          },
        ],
      }),
    );

    const rsp = await syncDeviceFiles({
      deviceId: DEVICE_ID,
      pathSyntax: 'posix',
      files: [
        {
          fileId: null,
          absolutePath: '/report.log',
          mimeType: 'text/plain',
          extension: 'log',
          fileMetadataCreatedAt: CREATED_AT,
          fileMetadataModifiedAt: UPDATED_AT,
        },
        {
          fileId: FILE_ID,
          absolutePath: '/moved.log',
          mimeType: null,
          extension: null,
          fileMetadataCreatedAt: null,
          fileMetadataModifiedAt: null,
        },
      ],
    });

    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      path_syntax: 'posix',
      files: [
        {
          absolute_path: '/report.log',
          mime_type: 'text/plain',
          extension: 'log',
          file_metadata_created_at: CREATED_AT,
          file_metadata_modified_at: UPDATED_AT,
        },
        {
          file_id: FILE_ID,
          absolute_path: '/moved.log',
          mime_type: null,
          extension: null,
          file_metadata_created_at: null,
          file_metadata_modified_at: null,
        },
      ],
    });
    expect(rsp.results).toEqual([
      {
        Accepted: {
          index: 0,
          operation: 'created',
          root: expect.objectContaining({ entryId: ROOT_ID }),
          file: expect.objectContaining({ fileId: FILE_ID, hasContent: false }),
        },
      },
      {
        Rejected: {
          index: 1,
          error: {
            kind: 'validation',
            message: 'filesystem validation failed',
            fieldErrors: [['files[1].absolute_path', 'invalid']],
          },
        },
      },
    ]);
  });
  it('preserves Windows paths in sync request values', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse({ results: [] }));
    const absolutePath =
      'D:\\Counter-Strike Source v34 HD\\cstrike\\sound\\weapons\\csgo\\c4\\c4_plant.wav';

    await syncDeviceFiles({
      deviceId: DEVICE_ID,
      pathSyntax: 'windows',
      files: [
        {
          fileId: null,
          absolutePath,
          mimeType: null,
          extension: null,
          fileMetadataCreatedAt: null,
          fileMetadataModifiedAt: null,
        },
      ],
    });

    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      path_syntax: 'windows',
      files: [
        {
          absolute_path: absolutePath,
          mime_type: null,
          extension: null,
          file_metadata_created_at: null,
          file_metadata_modified_at: null,
        },
      ],
    });
  });
});

describe('DeviceUpdatePatchInput serialization', () => {
  it('omits undefined fields and preserves explicit null clears', () => {
    expect(
      toDeviceUpdatePatchReq({
        deviceId: DEVICE_ID,
        name: 'Renamed device',
        aorIds: [],
        unitId: null,
        externalUrl: null,
        customFields: { retired: null },
      }),
    ).toEqual({
      deviceId: DEVICE_ID,
      name: 'Renamed device',
      aorIds: [],
      unitId: null,
      externalUrl: null,
      customFields: { retired: null },
    });
  });
});
