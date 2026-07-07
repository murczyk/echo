/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDevice,
  createDeviceFiles,
  archiveDevice,
  deleteDeviceFile,
  getDeviceDetail,
  getDeviceUnitStats,
  listDeviceFiles,
  listDevices,
  restoreDevice,
  restoreDeviceFile,
  toDeviceUpdatePatchReq,
  updateDevice,
} from './devices';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const FILE_ID = '028f0000-0000-7000-8000-000000000000';

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
    created_by: 'operator',
    aor_ids: [4, 5],
    aor_names: ['AOR', 'AOR 2'],
    unit_id: 7,
    unit_name: 'Unit',
    tags: [{ label: 'Serial', value: '123' }],
    external_url: 'https://example.test/device',
    archived: false,
    created_at_ms: 10,
    updated_at_ms: 20,
    archived_at_ms: null,
  };
}

function mockListDevicesResponse() {
  return {
    list: [
      {
        id: DEVICE_ID,
        name: 'Device Alpha',
        created_by: 'operator',
        aor_ids: [4, 5],
        aor_names: ['AOR', 'AOR 2'],
        unit_id: 7,
        unit_name: 'Unit',
        external_url: null,
        archived: false,
        created_at_ms: 10,
        updated_at_ms: 20,
        archived_at_ms: null,
      },
    ],
    total: 1,
    has_more: false,
    status_counts: {
      active: 3,
      archived: 1,
    },
  };
}

function mockDeviceUnitStatsResponse() {
  return {
    units: [
      {
        unit_id: 7,
        count: 3,
      },
    ],
  };
}

function mockListDeviceFilesResponse() {
  return {
    list: [
      {
        file_id: FILE_ID,
        device_id: DEVICE_ID,
        original_name: 'scan.pdf',
        original_absolute_path: '/tmp/scan.pdf',
        original_created_at_ms: 30,
        original_modified_at_ms: 40,
        deleted: false,
        created_at_ms: 50,
        updated_at_ms: 60,
        deleted_at_ms: null,
      },
    ],
    total: 1,
    has_more: false,
  };
}

function mockCreateDeviceFilesResponse() {
  return { list: mockListDeviceFilesResponse().list };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(mockDeviceDetailsResponse())));
});

describe('devices API service routes', () => {
  it('listDevices uses /api/device/list and transforms request/response', async () => {
    const controller = new AbortController();
    fetchMock().mockResolvedValueOnce(jsonResponse(mockListDevicesResponse()));

    const rsp = await listDevices(
      {
        filterText: 'alpha',
        archivedFilter: 'active_only',
        aorIds: [4],
        unitIds: [7],
        createdBy: 'operator',
        ids: [DEVICE_ID],
        limit: 25,
        offset: 0,
        sortBy: ['updated_at_desc'],
      },
      { signal: controller.signal },
    );

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/list', expect.any(Object));
    expect(requestSignal()).toBe(controller.signal);
    expect(requestBody()).toMatchObject({
      filter_text: 'alpha',
      archived_filter: 'active_only',
      aor_ids: [4],
      unit_ids: [7],
      created_by: 'operator',
      ids: [DEVICE_ID],
      limit: 25,
      offset: 0,
      sort_by: ['updated_at_desc'],
    });
    expect(rsp.list[0].createdBy).toBe('operator');
    expect(rsp.statusCounts).toEqual({ active: 3, archived: 1 });
    expect(rsp.hasMore).toBe(false);
  });

  it('getDeviceUnitStats uses /api/device/unit-stats and transforms response', async () => {
    const controller = new AbortController();
    fetchMock().mockResolvedValueOnce(jsonResponse(mockDeviceUnitStatsResponse()));

    const rsp = await getDeviceUnitStats({ signal: controller.signal });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/unit-stats', expect.any(Object));
    expect(requestSignal()).toBe(controller.signal);
    expect(requestBody()).toBeUndefined();
    expect(rsp).toEqual([{ unitId: 7, count: 3 }]);
  });

  it('getDeviceDetail uses /api/device/detail', async () => {
    const rsp = await getDeviceDetail({ deviceId: DEVICE_ID, includeArchived: true });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/detail', expect.any(Object));
    expect(requestBody()).toEqual({ device_id: DEVICE_ID, include_archived: true });
    expect(rsp.createdAtMs).toBe(10);
  });

  it('createDevice uses /api/device/create', async () => {
    await createDevice({
      name: 'Device Alpha',
      aorIds: [4, 5],
      unitId: 7,
      tags: [{ label: 'Serial', value: '123' }],
      externalUrl: null,
      files: null,
    });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/create', expect.any(Object));
    expect(requestBody()).toMatchObject({
      name: 'Device Alpha',
      aor_ids: [4, 5],
      unit_id: 7,
      tags: [{ label: 'Serial', value: '123' }],
      external_url: null,
      files: null,
    });
  });

  it('updateDevice uses /api/device/update and serialized patch body', async () => {
    await updateDevice({ deviceId: DEVICE_ID, aorIds: [], unitId: 7, files: [] });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/update', expect.any(Object));
    expect(requestBody()).toEqual({ device_id: DEVICE_ID, aor_ids: [], unit_id: 7 });
  });

  it('archiveDevice uses /api/device/archive', async () => {
    await archiveDevice({ deviceId: DEVICE_ID });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/archive', expect.any(Object));
    expect(requestBody()).toEqual({ device_id: DEVICE_ID });
  });

  it('restoreDevice uses /api/device/restore', async () => {
    await restoreDevice({ deviceId: DEVICE_ID });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/restore', expect.any(Object));
    expect(requestBody()).toEqual({ device_id: DEVICE_ID });
  });

  it('listDeviceFiles uses /api/device/files/list and transforms response', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse(mockListDeviceFilesResponse()));

    const rsp = await listDeviceFiles({
      deviceId: DEVICE_ID,
      deletedFilter: 'all',
      limit: 50,
      offset: 10,
    });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/files/list', expect.any(Object));
    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      deleted_filter: 'all',
      limit: 50,
      offset: 10,
    });
    expect(rsp.list[0].fileId).toBe(FILE_ID);
    expect(rsp.list[0].originalAbsolutePath).toBe('/tmp/scan.pdf');
  });

  it('createDeviceFiles uses /api/device/files/create', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse(mockCreateDeviceFilesResponse()));

    const rsp = await createDeviceFiles({
      deviceId: DEVICE_ID,
      files: [
        {
          originalName: 'scan.pdf',
          originalAbsolutePath: '/tmp/scan.pdf',
          originalCreatedAtMs: 30,
          originalModifiedAtMs: 40,
        },
      ],
    });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/files/create', expect.any(Object));
    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      files: [
        {
          original_name: 'scan.pdf',
          original_absolute_path: '/tmp/scan.pdf',
          original_created_at_ms: 30,
          original_modified_at_ms: 40,
        },
      ],
    });
    expect(rsp.list[0].fileId).toBe(FILE_ID);
  });

  it('deleteDeviceFile uses /api/device/files/delete and transforms file response', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse(mockListDeviceFilesResponse().list[0]));

    const rsp = await deleteDeviceFile({ deviceId: DEVICE_ID, fileId: FILE_ID });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/files/delete', expect.any(Object));
    expect(requestBody()).toEqual({ device_id: DEVICE_ID, file_id: FILE_ID });
    expect(rsp.fileId).toBe(FILE_ID);
  });

  it('restoreDeviceFile uses /api/device/files/restore and transforms file response', async () => {
    fetchMock().mockResolvedValueOnce(jsonResponse(mockListDeviceFilesResponse().list[0]));

    const rsp = await restoreDeviceFile({ deviceId: DEVICE_ID, fileId: FILE_ID });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/files/restore', expect.any(Object));
    expect(requestBody()).toEqual({ device_id: DEVICE_ID, file_id: FILE_ID });
    expect(rsp.fileId).toBe(FILE_ID);
  });
});

describe('DeviceUpdatePatchInput serialization', () => {
  it('omits undefined fields and preserves explicit null clears', () => {
    expect(
      toDeviceUpdatePatchReq({
        deviceId: DEVICE_ID,
        name: undefined,
        aorIds: [],
        unitId: null,
        tags: undefined,
        externalUrl: null,
        files: [],
      }),
    ).toEqual({
      deviceId: DEVICE_ID,
      aorIds: [],
      unitId: null,
      externalUrl: null,
    });
  });

  it('never serializes name null or tags null and clears tags with []', () => {
    expect(
      toDeviceUpdatePatchReq({
        deviceId: DEVICE_ID,
        name: null,
        tags: null,
      } as never),
    ).toEqual({ deviceId: DEVICE_ID });

    expect(toDeviceUpdatePatchReq({ deviceId: DEVICE_ID, tags: [] })).toEqual({
      deviceId: DEVICE_ID,
      tags: [],
    });
  });

  it('includes files only when non-empty', () => {
    expect(toDeviceUpdatePatchReq({ deviceId: DEVICE_ID, files: [] })).toEqual({
      deviceId: DEVICE_ID,
    });
    expect(
      toDeviceUpdatePatchReq({
        deviceId: DEVICE_ID,
        files: [
          {
            originalName: 'scan.pdf',
            originalAbsolutePath: null,
            originalCreatedAtMs: null,
            originalModifiedAtMs: null,
          },
        ],
      }),
    ).toEqual({
      deviceId: DEVICE_ID,
      files: [
        {
          originalName: 'scan.pdf',
          originalAbsolutePath: null,
          originalCreatedAtMs: null,
          originalModifiedAtMs: null,
        },
      ],
    });
  });
});
