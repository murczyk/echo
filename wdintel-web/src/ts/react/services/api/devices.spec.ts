/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  browseDeviceFiles,
  countDeviceFileSubtrees,
  createDevice,
  getDeviceDetail,
  getDeviceAnalyticsSummary,
  getAnalysisRun,
  getDeviceUnitStats,
  listDeviceAors,
  listDeviceUnits,
  listAnalyticsTags,
  listAnalysisRuns,
  listAnalysisRunFiles,
  journalDeviceFiles,
  listDeviceFileRoots,
  listDevices,
  searchDeviceFiles,
  listDeviceAnalyticsFiles,
  syncDeviceFiles,
  reanalyzeAll,
  reanalyzeDevice,
  toDeviceUpdatePatchReq,
  updateDevice,
  updateDeviceSettings,
} from './devices';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const ENTRY_ID = '018f0000-0000-7000-8000-000000000002';
const FILE_ID = '018f0000-0000-7000-8000-000000000003';
const SYNC_ID = '018f0000-0000-7000-8000-000000000005';
const TAG_ID = '018f0000-0000-7000-8000-000000000004';
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
    name: 'C:\\',
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
    absolute_path: 'C:\\report.log',
    has_content: false,
    name: 'report.log',
    path_components: ['report.log'],
    mime_type: 'text/plain',
    extension: 'log',
    file_metadata_created_at: CREATED_AT,
    file_metadata_modified_at: UPDATED_AT,
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    revision: 1,
    sync_id: SYNC_ID,
    source_file_state: null,
    tags: [],
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(mockDeviceDetailsResponse())));
});

function mockSyncSummaryResponse() {
  return {
    sync_id: SYNC_ID,
    device_id: DEVICE_ID,
    mode: 'automatic',
    status: 'completed_with_errors',
    next_batch_index: 1,
    counts: {
      received: 2,
      accepted: 1,
      created: 1,
      updated: 0,
      rejected: 1,
    },
    created_at: CREATED_AT,
    updated_at: UPDATED_AT,
    completed_at: UPDATED_AT,
    expires_at: null,
  };
}

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

  it('posts the masked device settings contract without converting its camel-case fields', async () => {
    fetchMock().mockImplementation(() =>
      Promise.resolve(jsonResponse({ hasMattermostWebhook: true })),
    );

    const settings = await updateDeviceSettings({});
    await updateDeviceSettings({
      mattermostWebhookUrl: 'https://mattermost.example/hooks/device-secret',
    });
    await updateDeviceSettings({ clearMattermostWebhook: true });

    expect(fetchMock()).toHaveBeenNthCalledWith(
      1,
      '/api/admin/device/settings',
      expect.any(Object),
    );
    expect(requestBody(0)).toEqual({});
    expect(requestBody(1)).toEqual({
      mattermostWebhookUrl: 'https://mattermost.example/hooks/device-secret',
    });
    expect(requestBody(2)).toEqual({ clearMattermostWebhook: true });
    expect(settings).toEqual({ hasMattermostWebhook: true });
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
        breadcrumbs: [{ entry_id: ROOT_ID, name: 'C:\\' }],
        entries: [
          {
            entry_id: ENTRY_ID,
            parent_entry_id: ROOT_ID,
            kind: 'file',
            file_id: FILE_ID,
            name: 'report.log',
            path_components: ['report.log'],
            absolute_path: 'C:\\report.log',
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
      tagIds: [TAG_ID],
      tagMatch: 'all',
      untagged: false,
    });
    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      parent_entry_id: ROOT_ID,
      include_breadcrumbs: true,
      limit: 25,
      cursor: null,
      tag_ids: [TAG_ID],
      tag_match: 'all',
      untagged: false,
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
      tagIds: [TAG_ID],
      tagMatch: 'any',
      untagged: false,
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
      tag_ids: [TAG_ID],
      tag_match: 'any',
      untagged: false,
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
            revision: 1,
            sync_id: SYNC_ID,
            source_file_state: {
              state: 'downloaded',
              settled_at: UPDATED_AT,
              settled_by: 'device-source',
            },
            tags: [],
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
      tagIds: [],
      tagMatch: 'any',
      untagged: true,
    });
    expect(fetchMock()).toHaveBeenCalledWith('/api/device/files/journal', expect.any(Object));
    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      limit: 100,
      cursor: null,
      tag_ids: [],
      tag_match: 'any',
      untagged: true,
    });
    expect(rsp).toEqual({
      entries: [
        {
          fileId: FILE_ID,
          name: 'report.log',
          absolutePath: '/report.log',
          hasContent: true,
          synchronizedAt: UPDATED_AT,
          revision: 1,
          syncId: SYNC_ID,
          sourceFileState: {
            state: 'downloaded',
            settledAt: UPDATED_AT,
            settledBy: 'device-source',
          },
          tags: [],
        },
      ],
      totalCount: 12_345,
      nextCursor: 'next',
    });
  });

  it('sends path identity and normalizes the sync summary and item outcomes', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        sync: mockSyncSummaryResponse(),
        results: [
          {
            status: 'accepted',
            index: 0,
            operation: 'created',
            file_id: FILE_ID,
            revision: 1,
            file: mockFileResponse(),
          },
          {
            status: 'rejected',
            index: 1,
            code: 'validation',
            message: 'file validation failed',
            field_errors: [{ path: 'files[1].absolute_path', message: 'invalid' }],
          },
        ],
      }),
    );

    const rsp = await syncDeviceFiles({
      deviceId: DEVICE_ID,
      files: [
        {
          absolutePath: 'C:\\report.log',
          mimeType: 'text/plain',
          extension: 'log',
          fileMetadataCreatedAt: CREATED_AT,
          fileMetadataModifiedAt: UPDATED_AT,
          sourceFileState: {
            state: 'downloaded',
            settledAt: UPDATED_AT,
            settledBy: 'device-source',
          },
        },
        {
          absolutePath: 'C:\\moved.log',
          mimeType: null,
          extension: null,
          fileMetadataCreatedAt: null,
          fileMetadataModifiedAt: null,
          sourceFileState: null,
        },
      ],
    });

    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      files: [
        {
          absolute_path: 'C:\\report.log',
          mime_type: 'text/plain',
          extension: 'log',
          file_metadata_created_at: CREATED_AT,
          file_metadata_modified_at: UPDATED_AT,
          source_file_state: {
            state: 'downloaded',
            settled_at: UPDATED_AT,
            settled_by: 'device-source',
          },
        },
        {
          absolute_path: 'C:\\moved.log',
          mime_type: null,
          extension: null,
          file_metadata_created_at: null,
          file_metadata_modified_at: null,
          source_file_state: null,
        },
      ],
    });
    expect(rsp.sync).toMatchObject({
      syncId: SYNC_ID,
      mode: 'automatic',
      counts: { accepted: 1, rejected: 1 },
    });
    expect(rsp.results).toEqual([
      {
        Accepted: {
          index: 0,
          operation: 'created',
          fileId: FILE_ID,
          revision: 1,
          file: expect.objectContaining({ fileId: FILE_ID, hasContent: false }),
        },
      },
      {
        Rejected: {
          index: 1,
          code: 'validation',
          message: 'file validation failed',
          fieldErrors: [{ path: 'files[1].absolute_path', message: 'invalid' }],
        },
      },
    ]);
  });
  it('preserves Windows paths in sync request values', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({ sync: mockSyncSummaryResponse(), results: [] }),
    );
    const absolutePath =
      'D:\\Counter-Strike Source v34 HD\\cstrike\\sound\\weapons\\csgo\\c4\\c4_plant.wav';

    await syncDeviceFiles({
      deviceId: DEVICE_ID,
      files: [
        {
          absolutePath,
          mimeType: null,
          extension: null,
          fileMetadataCreatedAt: null,
          fileMetadataModifiedAt: null,
          sourceFileState: null,
        },
      ],
    });

    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      files: [
        {
          absolute_path: absolutePath,
          mime_type: null,
          extension: null,
          file_metadata_created_at: null,
          file_metadata_modified_at: null,
          source_file_state: null,
        },
      ],
    });
  });
});

describe('device analytics API service routes', () => {
  it('loads dynamic tags and summary rows with canonical field names', async () => {
    fetchMock()
      .mockResolvedValueOnce(
        jsonResponse({
          tags: [{ id: TAG_ID, name: 'Звіти' }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          total_file_count: 20,
          analyzed_file_count: 12,
          items: [
            {
              tag: { id: TAG_ID, name: 'Звіти' },
              file_count: 12,
              latest_file_entry_created_at: CREATED_AT,
            },
          ],
        }),
      );

    const tags = await listAnalyticsTags({ deviceId: DEVICE_ID });
    const summary = await getDeviceAnalyticsSummary({ deviceId: DEVICE_ID });

    expect(fetchMock().mock.calls[0][0]).toBe('/api/device/analytics/tags');
    expect(requestBody(0)).toEqual({ device_id: DEVICE_ID });
    expect(tags.tags).toEqual([{ id: TAG_ID, name: 'Звіти' }]);
    expect(fetchMock().mock.calls[1][0]).toBe('/api/device/analytics/summary');
    expect(requestBody(1)).toEqual({ device_id: DEVICE_ID });
    expect(summary.totalFileCount).toBe(20);
    expect(summary.analyzedFileCount).toBe(12);
    expect(summary.items).toEqual([
      {
        tag: { id: TAG_ID, name: 'Звіти' },
        fileCount: 12,
        latestFileEntryCreatedAt: CREATED_AT,
      },
    ]);
  });

  it('loads one tag file page with stable cursor fields', async () => {
    fetchMock().mockResolvedValueOnce(
      jsonResponse({
        files: [
          {
            file_id: FILE_ID,
            name: 'report.log',
            absolute_path: 'C:\\report.log',
            file_entry_created_at: CREATED_AT,
          },
        ],
        next_cursor: 'next',
      }),
    );

    const rsp = await listDeviceAnalyticsFiles({
      deviceId: DEVICE_ID,
      tagId: TAG_ID,
      limit: 10,
      cursor: null,
    });

    expect(fetchMock()).toHaveBeenCalledWith('/api/device/analytics/files', expect.any(Object));
    expect(requestBody()).toEqual({
      device_id: DEVICE_ID,
      tag_id: TAG_ID,
      limit: 10,
      cursor: null,
    });
    expect(rsp).toEqual({
      files: [
        {
          fileId: FILE_ID,
          name: 'report.log',
          absolutePath: 'C:\\report.log',
          fileEntryCreatedAt: CREATED_AT,
        },
      ],
      nextCursor: 'next',
    });
  });

  it('creates device and global reanalysis runs through the admin routes', async () => {
    const run = {
      run_id: 'run-1',
      device_id: DEVICE_ID,
      cause: 'manual_reanalysis',
      sync_id: null,
      target_source_sequence: 11,
      definition_id: 'definition-1',
      analyzer_version: 1,
      dsl_version: 1,
      status: 'preparing',
      item_count: 0,
      completed_count: 0,
      prepared_at: null,
      completed_at: null,
      created_at: CREATED_AT,
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ run }))
      .mockResolvedValueOnce(jsonResponse({ definition_id: 'definition-1', created_run_count: 5 }));

    const deviceRsp = await reanalyzeDevice({ deviceId: DEVICE_ID });
    const allRsp = await reanalyzeAll();

    expect(fetchMock().mock.calls[0][0]).toBe('/api/admin/device-analytics/reanalyze/device');
    expect(requestBody(0)).toEqual({ device_id: DEVICE_ID });
    expect(deviceRsp.run.runId).toBe('run-1');
    expect(deviceRsp.run).toMatchObject({
      runId: 'run-1',
      cause: 'manual_reanalysis',
      syncId: null,
      targetSourceSequence: 11,
    });
    expect(fetchMock().mock.calls[1][0]).toBe('/api/admin/device-analytics/reanalyze/all');
    expect(requestBody(1)).toBeUndefined();
    expect(allRsp).toEqual({ definitionId: 'definition-1', createdRunCount: 5 });
  });

  it('loads run status, device run history, and historical file results', async () => {
    const run = {
      run_id: 'run-1',
      device_id: DEVICE_ID,
      cause: 'manual_reanalysis',
      sync_id: null,
      target_source_sequence: 11,
      definition_id: 'definition-1',
      analyzer_version: 1,
      dsl_version: 1,
      status: 'completed',
      item_count: 2,
      completed_count: 2,
      prepared_at: CREATED_AT,
      completed_at: UPDATED_AT,
      created_at: CREATED_AT,
    };
    fetchMock()
      .mockResolvedValueOnce(jsonResponse({ run }))
      .mockResolvedValueOnce(jsonResponse({ runs: [run], next_cursor: 'runs-next' }))
      .mockResolvedValueOnce(
        jsonResponse({
          files: [
            {
              file_id: FILE_ID,
              metadata_revision: 3,
              analysis_input_revision: 2,
              state: 'completed',
              tag_ids: [TAG_ID],
              metadata: {
                name: 'report.log',
                absolute_path: 'C:\\report.log',
                extension: 'log',
                mime_type: 'text/plain',
                file_metadata_created_at: CREATED_AT,
                file_metadata_modified_at: UPDATED_AT,
                source_file_state: null,
              },
            },
          ],
          next_cursor: null,
        }),
      );

    const getRsp = await getAnalysisRun({ runId: 'run-1' });
    const listRsp = await listAnalysisRuns({
      deviceId: DEVICE_ID,
      limit: 25,
      cursor: null,
    });
    const filesRsp = await listAnalysisRunFiles({
      runId: 'run-1',
      limit: 25,
      cursor: null,
    });

    expect(requestBody(0)).toEqual({ run_id: 'run-1' });
    expect(requestBody(1)).toEqual({ device_id: DEVICE_ID, limit: 25, cursor: null });
    expect(requestBody(2)).toEqual({ run_id: 'run-1', limit: 25, cursor: null });
    expect(getRsp.run.status).toBe('completed');
    expect(listRsp).toMatchObject({ runs: [{ runId: 'run-1' }], nextCursor: 'runs-next' });
    expect(filesRsp.files[0]).toMatchObject({
      fileId: FILE_ID,
      state: 'completed',
      tagIds: [TAG_ID],
      metadata: { absolutePath: 'C:\\report.log', sourceFileState: null },
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
