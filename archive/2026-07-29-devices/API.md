# Devices HTTP API

## Conventions

All 34 endpoints are authenticated `POST` routes. JSON request objects reject
unknown fields. UUIDs in JSON are lowercase canonical hyphenated strings;
timestamps are RFC 3339 strings with an explicit timezone. Response timestamps
are UTC.

In the shapes below, `?` means that a request field may be omitted and
`T | null` means that the response always contains the field but may return
`null`. Cursors are opaque and valid only for the route and scope that issued
them.

The seven registry routes use `wd`. Every `/files/*`, `/analytics/*`, and
`/admin/device-analytics/*` route also requires `wd_files`; without
`[file_registry]` it returns:

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 60

Device file operations are unavailable because the [file_registry] configuration section is missing.
```

## Common errors

| Status | Body | Meaning |
| --- | --- | --- |
| `400` | `[["field", "message"]]` | Registry, navigation, or sync form validation |
| `400` | `{"path":"...","code":"...","message":"..."}` | Analytics or rule validation |
| `400` | framework error body | Malformed JSON, unknown field, or wrong JSON type |
| `401` | `Unauthenticated` | Missing or invalid session |
| `403` | `Forbidden` | Role or field-level operation is not allowed |
| `404` | `Not found` | Missing object or object outside organism visibility |
| `409` | `{"code":"...","message":"..."}` | Synchronization state conflict |
| `409` | `{"path":"name","code":"duplicate_name","message":"..."}` | Duplicate analytics-tag name |
| `500` | `Internal server error` | Database or invariant failure |

File-backed reads and writes first verify device visibility in `wd`. Public
Devices routes allow `Cyber`, `DeviceSource`, and `Admin`; analytical device
fields require `DeviceSource` or `Admin`. Every admin analytics route requires
`Admin` independently.

## Device registry

### Endpoints

| Route | Request body | `200` response | Specific validation |
| --- | --- | --- | --- |
| `/api/device/list` | `ListDevicesReq` | `ListDevicesRsp` | limit, filter length, and contradictory sort directions |
| `/api/device/unit-stats` | none | `DeviceUnitStatsRsp` | — |
| `/api/device/aors` | none | `AreaOfResponsibility[]` | `DeviceSource` or `Admin` required |
| `/api/device/units` | none | `ListUnitsRsp` | `DeviceSource` or `Admin` required |
| `/api/device/detail` | `DeviceDetailReq` | `DeviceDetails` | active-only unless `include_archived` is true |
| `/api/device/create` | `CreateDeviceReq` | `DeviceDetails` | name, URL, and custom-field constraints |
| `/api/device/update` | `UpdateDeviceReq` | `DeviceDetails` | nonempty patch, field values, AORs, and unit |

### Requests

```text
ListDevicesReq {
  filter_text?: string
  archived_filter?: "active_only" | "archived_only" | "all"
  aor_ids?: integer[]
  unit_ids?: integer[]
  limit?: unsigned integer
  offset?: unsigned integer
  sort_by?: ("display_title_asc" | "display_title_desc" |
             "created_at_asc" | "created_at_desc" |
             "updated_at_asc" | "updated_at_desc")[]
}

DeviceDetailReq {
  device_id: uuid
  include_archived?: boolean
}

CreateDeviceReq {
  name?: string | null
  external_url?: string | null
  custom_fields?: { [key: string]: string }
}

UpdateDeviceReq {
  device_id: uuid
  name?: string
  external_url?: string | null
  custom_fields?: { [key: string]: string | null }
  aor_ids?: integer[]
  unit_id?: integer | null
}
```

The list defaults to active devices, `updated_at_desc`, `limit: 100`, and
`offset: 0`; the maximum limit is 100. An omitted update field is unchanged.
`null` clears `external_url` or `unit_id`; a `null` custom-field value deletes
that key. `name`, `custom_fields`, and `aor_ids` cannot be `null` when present.

### Responses

```text
AorSummary { id: integer, name: string }
UnitSummary { id: integer, name: string }
DeviceStatusCounts { active: integer, archived: integer }

DeviceListItem {
  id: uuid
  name: string | null
  aors: AorSummary[]
  unit: UnitSummary | null
  created_by: string
  archived: boolean
  created_at: timestamp
  updated_at: timestamp
  archived_at: timestamp | null
}

ListDevicesRsp {
  list: DeviceListItem[]
  total: unsigned integer
  has_more: boolean
  status_counts: DeviceStatusCounts
}

DeviceDetails {
  id: uuid
  name: string | null
  aors: AorSummary[]
  unit: UnitSummary | null
  external_url: string | null
  custom_fields: { [key: string]: string }
  created_by: string
  archived: boolean
  created_at: timestamp
  updated_at: timestamp
  archived_at: timestamp | null
}

DeviceUnitStatsRsp {
  units: { unit: UnitSummary, count: integer }[]
}
```

`AreaOfResponsibility` contains `id`, `name`, `description`, `is_top_level`,
`order_for_report`, `left_bound`, `right_bound`, nullable left/right
coordinates (`latitude`, `longitude`, `settlement`), and `created_at`.

`ListUnitsRsp` contains `show_load_more`, `total_count`,
`status_counts: {active, inactive}`, and `units`. Each shared `Unit` contains
its hierarchy fields (`other`, `team_or_crew`, `section`, `squad`, `platoon`,
`company`, `battalion`, `regiment`, `brigade`, `division`, `corps`, `army`,
`military_district`, `army_region`), `id`, `name`, `comment`, `orbit_note`,
`active`, `is_deduplicate_candidate`, `created_at`, `created_by_login_id`,
`has_orbit`, `orbit_unit_ids`, and `orbit_unit_generative_names`. Orbit fields
are redacted unless the caller has Orbit visibility.

### Example

```http
POST /api/device/update
Content-Type: application/json

{
  "device_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7001",
  "name": "Receiver 7",
  "external_url": null,
  "custom_fields": {
    "serial": "RX-2048",
    "obsolete_key": null
  },
  "aor_ids": [12, 31],
  "unit_id": 44
}
```

## File navigation

### Endpoints

| Route | Request body | `200` response | Limits and errors |
| --- | --- | --- | --- |
| `/api/device/files/roots` | `{device_id}` | `{roots: DeviceFileRoot[]}` | visible device required |
| `/api/device/files/subtree-counts` | `CountDeviceFileSubtreesReq` | `{counts: {entry_id, file_count}[]}` | at most 100 directory IDs; every directory must belong to the scope |
| `/api/device/files/browse` | `BrowseDeviceFilesReq` | `BrowseDeviceFilesRsp` | directory and cursor must belong to the device and filter |
| `/api/device/files/search` | `SearchDeviceFilesReq` | `SearchDeviceFilesRsp` | search/filter/date/cursor validation |
| `/api/device/files/journal` | `JournalDeviceFilesReq` | `JournalDeviceFilesRsp` | cursor and tag-filter validation |

### Requests

```text
CountDeviceFileSubtreesReq {
  device_id: uuid
  parent_entry_id?: uuid | null
  directory_entry_ids: uuid[]
}

BrowseDeviceFilesReq {
  device_id: uuid
  parent_entry_id: uuid
  include_breadcrumbs?: boolean
  limit?: unsigned integer
  cursor?: cursor | null
  tag_ids?: uuid[]
  tag_match?: "any" | "all"
  untagged?: boolean
}

SearchDeviceFilesReq {
  device_id: uuid
  scope_entry_id: uuid
  name_query?: string | null
  kinds?: ("directory" | "file")[]
  mime_types?: string[]
  extensions?: string[]
  file_metadata_modified_from?: timestamp | null
  file_metadata_modified_to?: timestamp | null
  limit?: unsigned integer
  cursor?: cursor | null
  tag_ids?: uuid[]
  tag_match?: "any" | "all"
  untagged?: boolean
}

JournalDeviceFilesReq {
  device_id: uuid
  limit?: unsigned integer
  cursor?: cursor | null
  tag_ids?: uuid[]
  tag_match?: "any" | "all"
  untagged?: boolean
}
```

Navigation pages default to 100 and accept `1..100`. Search accepts at most 50
values per filter and a nonempty `name_query` of 3..255 characters.
`untagged: true` cannot be combined with `tag_ids`; `tag_match` requires at
least one active, nonduplicate tag ID and defaults to `any` when IDs are
present.

### Responses

```text
AnalyticsTag { id: uuid, name: string }
SourceFileState { state: "scanned" | "downloaded" | "changed",
                  settled_at: timestamp, settled_by: string }

DeviceFileRoot {
  entry_id: uuid
  device_id: uuid
  parent_entry_id: null
  kind: "directory"
  name: string
  created_at: timestamp
  updated_at: timestamp
  tags: AnalyticsTag[]
}

DeviceFileTreeEntry {
  entry_id: uuid
  parent_entry_id: uuid
  kind: "directory" | "file"
  file_id: uuid | null
  name: string
  path_components: string[]
  absolute_path: string | null
  has_content: boolean
  mime_type: string | null
  extension: string | null
  file_metadata_created_at: timestamp | null
  file_metadata_modified_at: timestamp | null
  created_at: timestamp
  updated_at: timestamp
  revision: integer | null
  sync_id: uuid | null
  source_file_state: SourceFileState | null
  tags: AnalyticsTag[]
}

BrowseDeviceFilesRsp {
  breadcrumbs: { entry_id: uuid, name: string }[]
  entries: DeviceFileTreeEntry[]
  next_cursor: cursor | null
}

SearchDeviceFilesRsp {
  entries: DeviceFileTreeEntry[]
  next_cursor: cursor | null
}

DeviceFileJournalEntry {
  file_id: uuid
  name: string
  absolute_path: string
  has_content: boolean
  synchronized_at: timestamp
  revision: integer
  sync_id: uuid
  source_file_state: SourceFileState | null
  tags: AnalyticsTag[]
}

JournalDeviceFilesRsp {
  entries: DeviceFileJournalEntry[]
  total_count: unsigned integer
  next_cursor: cursor | null
}
```

### Example

```http
POST /api/device/files/search
Content-Type: application/json

{
  "device_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7001",
  "scope_entry_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7010",
  "name_query": "report",
  "kinds": ["file"],
  "extensions": ["pdf", "docx"],
  "tag_ids": ["0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7020"],
  "tag_match": "any",
  "limit": 50
}
```

## File synchronization

The behavioral contract is in [File metadata synchronization](SYNC.md).

### Endpoints

| Route | Request | Success response | State errors |
| --- | --- | --- | --- |
| `/api/device/files/sync` | `SyncDeviceFilesReq` body | `200 SyncDeviceFilesRsp` | `409 active_session` |
| `/api/device/files/sync-session` | `{device_id}` body | `201 FileSyncSessionRsp` for a new session; `200` for the existing open explicit session | `409 active_session` when automatic sync owns the device |
| `/api/device/files/sync-session/{sync_id}` | path `sync_id`; no body | `200 FileSyncSessionRsp` | `404` missing or invisible session |
| `/api/device/files/sync-session/{sync_id}/batches/{batch_index}` | path UUID and nonnegative integer; `{files}` body | `200 ApplyFileSyncBatchRsp` | `wrong_next_batch`, `terminal_session`, `batch_processing` |
| `/api/device/files/sync-session/{sync_id}/complete` | path `sync_id`; `{expected_batch_count}` body | `200 FileSyncSessionRsp` | `complete_mismatch`, `terminal_session`, `batch_processing` |
| `/api/device/files/sync-session/{sync_id}/items` | query `outcome?`, `limit?`, `cursor?`; no body | `200 FileSyncSessionItemsRsp` | invalid outcome, limit, or cursor |

`outcome` is `created`, `updated`, or `rejected`. Outcome pages default to 100
and accept `1..100`.

### Request items

```text
SyncDeviceFilesReq {
  device_id: uuid
  files: SyncDeviceFileItem[1..1000]
}

ApplyFileSyncBatchReq {
  files: SyncDeviceFileItem[1..1000]
}

SyncDeviceFileItem {
  absolute_path: absolute Windows file path
  mime_type?: string | null
  extension?: string | null
  file_metadata_created_at?: timestamp | null
  file_metadata_modified_at?: timestamp | null
  source_file_state?: {
    state: "scanned" | "downloaded" | "changed"
    settled_at: timestamp
    settled_by: nonempty string
  } | null
}

CompleteFileSyncSessionReq {
  expected_batch_count: unsigned integer <= 2147483647
}
```

`source_file_state` is all-or-none. Item timestamps without an explicit offset
are rejected. A valid item may still return a terminal item-level rejection;
only an invalid top-level batch fails the entire request with HTTP `400`.

### Response objects

```text
SyncCounts {
  received: unsigned integer
  accepted: unsigned integer
  created: unsigned integer
  updated: unsigned integer
  rejected: unsigned integer
}

SyncSummary {
  sync_id: uuid
  device_id: uuid
  mode: "automatic" | "explicit"
  status: "open" | "completed" | "completed_with_errors" | "expired"
  analysis_run_id: uuid | null
  next_batch_index: unsigned integer
  counts: SyncCounts
  created_at: timestamp
  updated_at: timestamp
  completed_at: timestamp | null
  expires_at: timestamp | null
}

BatchSummary {
  sync_id: uuid
  batch_index: unsigned integer
  status: "processing" | "applied" | "applied_with_errors"
  counts: SyncCounts
  created_at: timestamp
  applied_at: timestamp | null
}

DeviceFile {
  file_id: uuid
  device_id: uuid
  parent_entry_id: uuid
  root_entry_id: uuid
  absolute_path: string
  has_content: boolean
  name: string
  path_components: string[]
  mime_type: string | null
  extension: string | null
  file_metadata_created_at: timestamp | null
  file_metadata_modified_at: timestamp | null
  created_at: timestamp
  updated_at: timestamp
  revision: integer
  sync_id: uuid
  source_file_state: SourceFileState | null
  tags: AnalyticsTag[]
}
```

Immediate result union:

```text
Accepted {
  status: "accepted"
  index: unsigned integer
  operation: "created" | "updated"
  file_id: uuid
  revision: integer
  file: DeviceFile
}

Rejected {
  status: "rejected"
  index: unsigned integer
  code: "validation" | "duplicate_path_in_session"
  message: string
  field_errors: { path: string, message: string }[]
}

SyncDeviceFilesRsp {
  sync: SyncSummary
  results: (Accepted | Rejected)[]
}

ApplyFileSyncBatchRsp {
  sync: SyncSummary
  batch: BatchSummary
  results: (Accepted | Rejected)[]
}
```

Recovery results replace `index` with `batch_index` and `item_index`.
`FileSyncSessionItemsRsp` contains `sync`, `results`, and nullable
`next_cursor`.

### Automatic example

```http
POST /api/device/files/sync
Content-Type: application/json

{
  "device_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7001",
  "files": [
    {
      "absolute_path": "C:\\reports\\daily.pdf",
      "mime_type": "application/pdf",
      "extension": "pdf",
      "file_metadata_created_at": "2026-08-18T08:00:00+03:00",
      "file_metadata_modified_at": "2026-08-18T09:15:00+03:00",
      "source_file_state": {
        "state": "downloaded",
        "settled_at": "2026-08-18T09:16:00+03:00",
        "settled_by": "still-01"
      }
    }
  ]
}
```

```json
{
  "sync": {
    "sync_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7002",
    "device_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7001",
    "mode": "automatic",
    "status": "completed",
    "analysis_run_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7004",
    "next_batch_index": 1,
    "counts": {
      "received": 1,
      "accepted": 1,
      "created": 1,
      "updated": 0,
      "rejected": 0
    },
    "created_at": "2026-08-18T06:16:01Z",
    "updated_at": "2026-08-18T06:16:01Z",
    "completed_at": "2026-08-18T06:16:01Z",
    "expires_at": null
  },
  "results": [
    {
      "status": "accepted",
      "index": 0,
      "operation": "created",
      "file_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7003",
      "revision": 1,
      "file": {
        "file_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7003",
        "device_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7001",
        "parent_entry_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7011",
        "root_entry_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7010",
        "absolute_path": "C:\\reports\\daily.pdf",
        "has_content": false,
        "name": "daily.pdf",
        "path_components": ["reports", "daily.pdf"],
        "mime_type": "application/pdf",
        "extension": "pdf",
        "file_metadata_created_at": "2026-08-18T05:00:00Z",
        "file_metadata_modified_at": "2026-08-18T06:15:00Z",
        "created_at": "2026-08-18T06:16:01Z",
        "updated_at": "2026-08-18T06:16:01Z",
        "revision": 1,
        "sync_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7002",
        "source_file_state": {
          "state": "downloaded",
          "settled_at": "2026-08-18T06:16:00Z",
          "settled_by": "still-01"
        },
        "tags": []
      }
    }
  ]
}
```

### Explicit recovery example

```http
POST /api/device/files/sync-session/0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7002/items?outcome=rejected&limit=100
```

```json
{
  "sync": {
    "sync_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7002",
    "device_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7001",
    "mode": "explicit",
    "status": "completed_with_errors",
    "analysis_run_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7005",
    "next_batch_index": 2,
    "counts": {
      "received": 3,
      "accepted": 2,
      "created": 2,
      "updated": 0,
      "rejected": 1
    },
    "created_at": "2026-08-18T05:00:00Z",
    "updated_at": "2026-08-18T05:20:00Z",
    "completed_at": "2026-08-18T05:20:00Z",
    "expires_at": "2026-08-18T08:00:00Z"
  },
  "results": [
    {
      "status": "rejected",
      "batch_index": 1,
      "item_index": 0,
      "code": "validation",
      "message": "file validation failed",
      "field_errors": [
        {
          "path": "files[0].absolute_path",
          "message": "must be an absolute Windows file path"
        }
      ]
    }
  ],
  "next_cursor": null
}
```

## Public file analytics

The run and publication semantics are in [File analysis](ANALYSIS.md).

### Endpoints

| Route | Request body | `200` response | Limits and errors |
| --- | --- | --- | --- |
| `/api/device/analytics/runs/get` | `{run_id}` | `{run: AnalysisRun}` | `404` missing or invisible run |
| `/api/device/analytics/runs/list` | `{device_id, limit?, cursor?}` | `{runs: AnalysisRun[], next_cursor}` | default 100, maximum 500 |
| `/api/device/analytics/runs/files` | `{run_id, limit?, cursor?}` | `{files: AnalysisRunFile[], next_cursor}` | default 100, maximum 500; cursor is run-bound |
| `/api/device/analytics/tags` | `{device_id}` | `{tags: AnalyticsTag[]}` | active tags only |
| `/api/device/analytics/summary` | `{device_id}` | `DeviceAnalyticsSummaryRsp` | visible device required |
| `/api/device/analytics/files` | `{device_id, tag_id, limit?, cursor?}` | `{files: DeviceAnalyticsFile[], next_cursor}` | default 10, maximum 100; active tag required |

### Response objects

```text
AnalysisRun {
  run_id: uuid
  device_id: uuid
  cause: "sync" | "manual_reanalysis"
  sync_id: uuid | null
  definition_id: uuid
  target_source_sequence: integer | null
  analyzer_version: integer
  dsl_version: integer
  status: "preparing" | "running" | "completed"
  item_count: unsigned integer
  completed_count: unsigned integer
  created_at: timestamp
  prepared_at: timestamp | null
  completed_at: timestamp | null
}

AnalysisRunFileMetadata {
  name: string
  absolute_path: string
  extension: string | null
  mime_type: string | null
  file_metadata_created_at: timestamp | null
  file_metadata_modified_at: timestamp | null
  source_file_state: "scanned" | "downloaded" | "changed" | null
}

AnalysisRunFile {
  file_id: uuid
  metadata_revision: integer
  analysis_input_revision: integer
  state: "pending" | "processing" | "completed"
  metadata: AnalysisRunFileMetadata
  tag_ids: uuid[] | null
}

DeviceAnalyticsSummaryRsp {
  total_file_count: unsigned integer
  analyzed_file_count: unsigned integer
  items: {
    tag: AnalyticsTag
    file_count: unsigned integer
    latest_file_entry_created_at: timestamp
  }[]
}

DeviceAnalyticsFile {
  file_id: uuid
  name: string
  absolute_path: string
  file_entry_created_at: timestamp
}
```

`tag_ids` is `null` until the run item completes; a completed no-match result is
an empty array.

### Example

```http
POST /api/device/analytics/runs/list
Content-Type: application/json

{
  "device_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7001",
  "limit": 2
}
```

```json
{
  "runs": [
    {
      "run_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7004",
      "device_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7001",
      "cause": "sync",
      "sync_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7002",
      "definition_id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7030",
      "target_source_sequence": null,
      "analyzer_version": 1,
      "dsl_version": 1,
      "status": "completed",
      "item_count": 1,
      "completed_count": 1,
      "created_at": "2026-08-18T06:16:01Z",
      "prepared_at": "2026-08-18T06:16:02Z",
      "completed_at": "2026-08-18T06:16:03Z"
    }
  ],
  "next_cursor": null
}
```

## Admin file analytics

### Endpoints

| Route | Request body | `200` response | Specific errors |
| --- | --- | --- | --- |
| `/api/admin/device-analytics/tags/list` | none | `{tags: AdminAnalyticsTag[]}` | — |
| `/api/admin/device-analytics/tags/create` | `{name}` | `AdminAnalyticsTag` | `400` invalid name; `409 duplicate_name` |
| `/api/admin/device-analytics/tags/update` | `{id, name}` | `AdminAnalyticsTag` | invalid UUID/name, missing tag, duplicate name |
| `/api/admin/device-analytics/tags/archive` | `{id}` | `AdminAnalyticsTag` | invalid UUID or missing tag |
| `/api/admin/device-analytics/tags/restore` | `{id}` | `AdminAnalyticsTag` | invalid UUID or missing tag |
| `/api/admin/device-analytics/tags/rule/save` | `{id, rule_expression}` | `AdminAnalyticsTag` | strict DSL validation |
| `/api/admin/device-analytics/tags/rule/test-files/list` | `{id}` | `{files: RuleTestFile[]}` | missing tag |
| `/api/admin/device-analytics/tags/rule/test` | `{id, rule_expression, files}` | `{results: RuleTestFileResult[]}` | strict DSL/path validation; at most 100 files |
| `/api/admin/device-analytics/reanalyze/all` | none | `{definition_id, created_run_count}` | one bounded run per device with source data |
| `/api/admin/device-analytics/reanalyze/device` | `{device_id}` | `{run: AnalysisRun}` | invalid, missing, or invisible device |

A tag name is trimmed, Unicode-normalized, nonempty, case-insensitively unique,
and at most 128 characters. `rule_expression: null` removes the live rule.

### Rule expression

```text
RuleExpression =
  { op: "all", children: RuleExpression[] }
  | { op: "any", children: RuleExpression[] }
  | { op: "not", child: RuleExpression }
  | {
      op: "match"
      field: "file_name" | "directory_path" | "full_path" | "extension"
      matcher: "equals" | "contains" | "contains_token" | "regex"
      values: string[]
    }

AdminAnalyticsTag {
  id: uuid
  name: string
  rule_expression: RuleExpression | null
  archived_at: timestamp | null
  created_at: timestamp
  updated_at: timestamp
}

RuleTestFile {
  absolute_path: absolute Windows file path
  expected_match: boolean
}

RuleTestFileResult {
  index: unsigned integer
  matched: boolean
  passed: boolean
}
```

Rule validation errors use a JSON path into `rule_expression`, stable codes such
as `invalid_expression`, `max_depth_exceeded`, `max_nodes_exceeded`,
`empty_group`, `empty_values`, `max_values_exceeded`, `empty_literal`,
`duplicate_value`, `literal_too_long`, `regex_too_long`, and regex compilation
codes, plus a Ukrainian message.

### Rule-test example

```http
POST /api/admin/device-analytics/tags/rule/test
Content-Type: application/json

{
  "id": "0191e8e6-8d3d-7a20-8b8c-3c4d5e6f7020",
  "rule_expression": {
    "op": "match",
    "field": "extension",
    "matcher": "equals",
    "values": ["pdf"]
  },
  "files": [
    {
      "absolute_path": "C:\\reports\\daily.pdf",
      "expected_match": true
    },
    {
      "absolute_path": "C:\\reports\\daily.txt",
      "expected_match": false
    }
  ]
}
```

```json
{
  "results": [
    { "index": 0, "matched": true, "passed": true },
    { "index": 1, "matched": false, "passed": true }
  ]
}
```

The test replaces the tag's persisted ordered fixtures but does not save the
submitted rule or schedule analysis.

## Authority

Routes are registered from `wdintel-rs/src/devices/devices/mod.rs`,
`files/mod.rs`, and `analytics/mod.rs`. Request and response DTOs in their
respective `types.rs` files, generated frontend bindings, current handlers, and
focused API tests are authoritative.
