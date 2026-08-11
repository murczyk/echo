# 2026-07-29: Devices module

## Description

Echo has a Devices module for registering technical sources, maintaining
analytical metadata, and synchronizing file metadata through an optional,
separately configured file registry. Synchronized files are classified into
administrable analytics tags, exposed through tag-aware navigation and
per-device summaries, and processed by a durable background workflow.

## Architecture

The `devices` domain is split into device registry, file registry, and file
analytics subdomains. HTTP handlers form one conceptual API boundary; business
orchestration and persistence remain inside their respective subdomains.

```mermaid
flowchart LR
    Browser["Browser"]
    ExternalSource["External device source"]

    subgraph Host["Echo server"]
        subgraph Web["wdintel-rs"]
            API["Devices API boundary<br/>/api/device/*<br/>/api/admin/device-analytics/*"]
            Devices["devices<br/>registry operations and access checks"]
            Files["files<br/>navigation and synchronization"]
            Analytics["analytics<br/>tag rules, summaries, and filters"]
        end

        subgraph Bgworker["bgworker"]
            AnalyticsWorkers["device-file analytics pool<br/>4 workers; batches up to 1,000"]
        end

        subgraph MainPostgreSQL["wd"]
            DeviceTable[("device")]
            DeviceAorTable[("device_aor")]
        end

        subgraph FileRegistryPostgreSQL["wd_files"]
            FileEntryTable[("file_entry")]
            TagDefinitionTables[("analytics_tag<br/>analytics_tag_rule_set_state<br/>analytics_tag_test_file")]
            AnalysisStateTables[("file_analysis_control<br/>file_analysis_device_state<br/>file_analysis_state<br/>file_analysis_reanalysis_job")]
            DeviceFileTagTable[("device_file_tag")]
        end

        API -->|"device requests"| Devices
        API -->|"file requests"| Files
        API -->|"analytics and admin requests"| Analytics
        Files -->|"tag filters and hydration"| Analytics
        Devices <--> DeviceTable
        Devices <--> DeviceAorTable
        Files <--> FileEntryTable
        Analytics <--> TagDefinitionTables
        Analytics <--> AnalysisStateTables
        Analytics <--> DeviceFileTagTable
        Analytics --> FileEntryTable
        AnalyticsWorkers -->|"load revisioned rules"| TagDefinitionTables
        AnalyticsWorkers <--> AnalysisStateTables
        AnalyticsWorkers -->|"reconcile memberships"| DeviceFileTagTable
        FileEntryTable -->|"triggers enqueue metadata revisions"| AnalysisStateTables
    end

    Browser -->|"device and admin UI"| API
    ExternalSource -->|"file metadata sync"| API
```

When `[file_registry]` is configured, file-backed requests first authorize the
device and organism visibility in `wd`, then operate in `wd_files`. There is no
cross-database transaction. All file-analysis configuration, work state, and
results are isolated in `wd_files`; `wd` retains device identity, ownership,
and AOR relationships.

## Database model

The branch adds eight generated SeaORM entities under
`wdintel-rs/src/file_registry/entities`, each backed by a new `wd_files` table:

| Entity and table               | Responsibility                                                         |
| ------------------------------ | ---------------------------------------------------------------------- |
| `analytics_tag`                | User-managed tag identity, optional rule expression, and archive state |
| `analytics_tag_rule_set_state` | Singleton revision used for consistent rule snapshots                  |
| `analytics_tag_test_file`      | Ordered positive and negative fixtures retained by the rule tester     |
| `device_file_tag`              | Materialized many-to-many assignments between files and analytics tags |
| `file_analysis_control`        | Singleton initial-backfill cursor and generation allocator             |
| `file_analysis_device_state`   | Per-device queue state and lease                                       |
| `file_analysis_state`          | Per-file source, rule, generation, retry, error, and lease state       |
| `file_analysis_reanalysis_job` | Bounded global or device-scoped reanalysis expansion                   |

```mermaid
classDiagram
    direction LR

    class device["main.device"] {
        uuid id PK
        text name NULL
        text created_by FK
        bigint unit_id FK NULL
        jsonb tags
        text external_url NULL
        boolean archived
        timestamp archived_at NULL
        timestamp created_at
        timestamp updated_at
        jsonb custom_fields
        bigint organism_id FK
    }

    class device_aor["main.device_aor"] {
        uuid id PK
        uuid device_id FK, UK
        bigint aor_id FK, UK
        timestamp created_at
    }

    class file_entry["wd_files.file_entry"] {
        uuid id PK
        uuid device_id
        uuid parent_id FK NULL
        text kind
        text name
        text absolute_path NULL
        ltree hierarchy_path
        text mime_type NULL
        text extension NULL
        timestamp file_metadata_created_at NULL
        timestamp file_metadata_modified_at NULL
        timestamp created_at
        timestamp updated_at
        text content_path NULL
    }

    class analytics_tag["wd_files.analytics_tag"] {
        uuid id PK
        text name
        jsonb rule_expression NULL
        timestamptz archived_at NULL
        timestamptz created_at
        timestamptz updated_at
    }

    class analytics_tag_rule_set_state["wd_files.analytics_tag_rule_set_state"] {
        boolean id PK
        bigint revision
    }

    class analytics_tag_test_file["wd_files.analytics_tag_test_file"] {
        uuid id PK
        uuid tag_id FK, UK
        integer position UK
        text name
        text absolute_path
        text extension NULL
        timestamptz created_at
        timestamptz updated_at
        boolean expected_match
    }

    class device_file_tag["wd_files.device_file_tag"] {
        uuid id PK
        uuid file_entry_id FK, UK
        uuid device_id FK
        timestamptz file_entry_created_at
        uuid tag_id FK, UK
        timestamptz created_at
        timestamptz updated_at
    }

    class file_analysis_control["wd_files.file_analysis_control"] {
        boolean id PK
        uuid backfill_cursor NULL
        boolean backfill_complete
        bigint next_generation
        timestamptz created_at
        timestamptz updated_at
    }

    class file_analysis_device_state["wd_files.file_analysis_device_state"] {
        uuid device_id PK
        boolean pending
        uuid lease_token NULL
        timestamptz lease_expires_at NULL
        timestamptz available_at
        timestamptz created_at
        timestamptz updated_at
    }

    class file_analysis_state["wd_files.file_analysis_state"] {
        uuid file_entry_id PK, FK
        uuid device_id
        bigint source_revision
        bigint analyzed_source_revision
        bigint required_generation
        bigint analyzed_generation
        bigint analyzed_rule_revision
        boolean pending
        uuid lease_token NULL
        timestamptz lease_expires_at NULL
        timestamptz available_at
        integer attempt_count
        text last_error NULL
        timestamptz last_attempt_at NULL
        timestamptz created_at
        timestamptz updated_at
        boolean retry_exhausted
    }

    class file_analysis_reanalysis_job["wd_files.file_analysis_reanalysis_job"] {
        uuid id PK
        uuid device_id NULL
        bigint target_rule_revision
        bigint generation UK
        uuid upper_file_entry_id
        uuid cursor_file_entry_id NULL
        bigint scheduled_file_count
        bigint expanded_file_count
        timestamptz expanded_at NULL
        timestamptz created_at
        timestamptz updated_at
    }

    class login["main.login (existing)"] {
        uuid id PK
        text login UK
    }

    class organism["main.organism (existing)"] {
        bigint id PK
    }

    class sigint_unit["main.sigint_unit (existing)"] {
        bigint id PK
    }

    class area_of_responsibility["main.area_of_responsibility (existing)"] {
        bigint id PK
    }

    note for device "Stores source identity, analytical metadata, ownership, and lifecycle."
    note for device_aor "Joins devices to AORs; (device_id, aor_id) is unique."
    note for file_entry "Stores filesystem hierarchy and source metadata."
    note for analytics_tag "Stores tag identity, rule expression, and archive lifecycle."
    note for analytics_tag_rule_set_state "Serializes rule mutations through one revision."
    note for analytics_tag_test_file "Stores ordered expected rule outcomes."
    note for device_file_tag "Materializes file-to-tag matches and keyset ordering data."
    note for file_analysis_control "Tracks initial backfill and allocates generations."
    note for file_analysis_device_state "Coordinates one leased work stream per device."
    note for file_analysis_state "Tracks per-file revisions, leases, retries, and errors."
    note for file_analysis_reanalysis_job "Expands bounded scoped or global reanalysis work."

    device "0..*" --> "1" login : created_by FK
    device "0..*" --> "1" organism : organism_id FK
    device "0..*" --> "0..1" sigint_unit : unit_id FK
    device_aor "0..*" --> "1" device : device_id FK
    device_aor "0..*" --> "1" area_of_responsibility : aor_id FK
    file_entry "0..*" --> "0..1" file_entry : composite parent FK
    analytics_tag_test_file "0..*" --> "1" analytics_tag : tag_id FK
    device_file_tag "0..*" --> "1" analytics_tag : tag_id FK
    device_file_tag "0..*" --> "1" file_entry : composite file FK
    file_analysis_state "0..1" --> "1" file_entry : file_entry_id FK
    file_entry "0..*" ..> "1" device : device_id logical ownership
    file_analysis_device_state "0..1" ..> "1" device : device_id logical queue
    file_analysis_state "0..*" ..> "1" device : device_id logical ownership
    file_analysis_reanalysis_job "0..*" ..> "0..1" device : optional scope
```

Solid arrows are SQL foreign keys within one PostgreSQL database. The dotted
arrows represent logical ownership through UUIDs and intentionally do not
create cross-database constraints or cascades.

Within `wd_files`, `file_entry` uses the composite foreign key
`(device_id, parent_id)` to `(device_id, id)` for its hierarchy.
`device_file_tag` uses `(device_id, file_entry_id)` to reference the same
composite file identity, and `(file_entry_id, tag_id)` is unique.
`analytics_tag_test_file` is unique by `(tag_id, position)`, while tag names
are unique by a case-insensitive trimmed expression index.

The boolean primary keys in `analytics_tag_rule_set_state` and
`file_analysis_control` are constrained to `true`, enforcing one row in each
table. Reanalysis upper bounds and cursors, and the initial backfill cursor,
are deliberately soft file UUID references: they are durable scan positions,
not ownership relationships.

## Device file analysis

Only file metadata participates: file name, directory or full path, and
extension. PostgreSQL triggers advance `source_revision` after a file insert
or a relevant metadata change, while an incremental cursor backfills files
that predate the analysis tables.

The four workers lease one device and then file batches of at most 1,000. A
batch is committed only while its source revision, required generation, and
compiled rule-set revision remain current; tag membership reconciliation and
state acknowledgement occur in the same transaction. Expired leases are
recoverable, failed work is retried up to ten attempts, and newer metadata or
reanalysis resets exhausted work.

Rule-affecting changes advance the singleton rule revision but do not
implicitly rewrite historical assignments. Explicit global or device-scoped
reanalysis captures a bounded file set under a new generation and expands it
incrementally.

```mermaid
sequenceDiagram
    participant UI as Device and admin UI
    participant Source as External device source
    participant API as Devices API
    participant Entry as wd_files.file_entry
    participant Queue as Analysis state and jobs
    participant Worker as Analytics worker pool
    participant Rules as Revisioned tag rules
    participant Tags as device_file_tag

    Source->>API: Synchronize file metadata
    API->>Entry: Insert or update a file
    Entry-->>Queue: Trigger advances source revision and queues device

    opt Admin requests scoped or global reanalysis
        UI->>API: Reanalyze at current rule revision
        API->>Queue: Create bounded generation job
    end

    loop Device lease and batches up to 1,000
        Worker->>Queue: Claim device and file leases
        Worker->>Rules: Load compiled snapshot at revision R
        Worker->>Worker: Evaluate file metadata
        Worker->>Queue: Lock state and validate source and generation
        Worker->>Rules: Lock and verify revision R
        alt Source, generation, and rules are current
            Worker->>Tags: Reconcile memberships
            Worker->>Queue: Acknowledge revisions and release lease
        else Any snapshot became stale
            Worker->>Queue: Discard result and release lease
        end
    end

    UI->>API: Request summary, drill-down, or tag-filtered files
    API->>Tags: Read active memberships
    API-->>UI: Return counts, files, and tag badges
```

## Tag rules and user interfaces

Rules are typed boolean expression trees with `all`, `any`, `not`, and `match`
nodes. Match nodes target `file_name`, `directory_path`, `full_path`, or
`extension`, using equality, substring, token, or regular-expression matching.
The rule tester persists up to 100 ordered fixtures with an expected match and
reports the actual and expected result without changing live assignments.

A DML-only migration seeds twelve tags with fixed UUIDs and initial rules:
`Втрати`, `Доповіді`, `Озброєння`, `Штатки`, `Бойові документи`,
`Військовий файл`, `Карти командира`, `Плани противника`,
`Профільні програми`, `Робота з радіо`, `Маршрути, палітри`, and
`Паролі, доступи`. The seed uses `ON CONFLICT DO NOTHING`, increments the
rule-set revision only when it inserts at least one tag, and has a
non-destructive rollback because seeded rows immediately become user-managed.

The admin route `/admin/device-analytics` is titled `Аналіз пристроїв`. Its
initial `Основні налаштування` tab is intentionally empty; the lazy
`Теги пристроїв` tab contains tag create/rename, archive/restore, rule editing,
rule testing, and global reanalysis. Device details expose analysis progress,
tag summaries, paginated file drill-down, and admin-only device reanalysis.
File tree, search, and journal views expose active tag badges and
`any`/`all`/untagged filters.

## Deployment

The file-registry database is optional for the Echo installation as a whole,
but it is required for file operations and device-file analytics. Configure it
in `deploy/config.toml`, or in the TOML file selected through
`ECHO_CONFIG_PATH`:

```toml
[file_registry]
pg_host = "postgres-host"
pg_port = 5432
pg_user = "wd"
pg_password = "..."
pg_dbname = "wd_files"
```

The section itself is the opt-in switch. When it is absent and Devices is
disabled, Echo logs a warning. When Devices is enabled, Echo logs an actionable
error explaining how to add and provision `[file_registry]`. Neither message
blocks startup. When Devices is enabled without the file registry, the seven
main-database device routes remain available, while the six file routes and
thirteen analytics routes are unavailable.

The section's presence restores fail-fast database behavior: operators must
provision the configured database before restarting Echo, and connection or
migration failures block startup. After adding the section, create the database
once with the installed backend binary:

```sh
sudo /usr/bin/wdintel-rs --mode=live oneoff-create-file-registry-database
```

The standard `wd_files` migrations create the analytics tables, triggers,
indexes, singleton rows, and default tags. When the file registry is available,
the production bgworker starts the four-worker analytics pool; its incremental
backfill schedules pre-existing files without a separate operator command.
Historical files require an explicit admin reanalysis after later rule changes.

## Access and organism visibility

Backend authorization is the source of truth. The effective capabilities are:

| Role           | Read | Create, source data, and file sync | Analytical device fields | File analytics read | Tag/rule administration and reanalysis |
| -------------- | :--: | :--------------------------------: | :----------------------: | :-----------------: | :------------------------------------: |
| `Cyber`        | yes  |                yes                 |            no            |         yes         |                   no                   |
| `DeviceSource` | yes  |                yes                 |           yes            |         yes         |                   no                   |
| `Admin`        | yes  |                yes                 |           yes            |         yes         |                  yes                   |

Every device stores the organism of the user who created it. A user can see
devices owned by their own organism and by every non-deleted descendant at any
depth. Visibility does not flow upward or sideways: a child organism cannot see
its parent or siblings. The same predicate protects lists, details, updates,
statistics, file-registry handoffs, analytics summaries, and file drill-downs.

Archived devices remain available to read paths that explicitly include
archived records, including file metadata and analytics. Source and analytical
writes require an active device. All `/api/admin/device-analytics/*` routes
independently require the `Admin` role.

## File hierarchy

`file_entry` uses stable UUID identifiers, a parent relation, and a PostgreSQL
`ltree` hierarchy path. Each device can have independent POSIX and Windows
roots. Exact absolute paths are retained as mutable source locations.
Byte-preserving name keys provide deterministic ordering and enforce
uniqueness only for roots and virtual sibling directories; file paths are not
unique and do not identify file objects.

Directories are virtual metadata derived from synchronized paths. Public sync
requests submit files, and the business logic creates or reuses their virtual
directory chains. An item without `file_id` inserts a file leaf with a new
UUIDv7; an item with a known `file_id` updates or moves that existing leaf.
Directory mutation is not a public API.

Synchronization is cumulative rather than snapshot replacement. Omitting a
previously synchronized file does not delete or hide it. The server uses
`file_id`, not the path, as synchronization identity: repeating an item with a
known `file_id` reapplies its location and technical metadata, while repeating
the same path without `file_id` creates a distinct file. Multiple files may
therefore have the same path and may coexist with a same-named virtual
directory.

A batch is processed as ordered independent items inside the synchronization
contract. The response preserves request order and can contain both accepted
and rejected results. Validation failures do not discard successful siblings.
Database failures that invalidate the transaction are classified explicitly so
clients can retry the affected input after rollback.

File counts are exact and computed dynamically. The journal uses an indexed
exact device count; tree expansion groups an indexed `ltree` subtree scan by
the requested roots or directories. Counts are loaded only for the journal or
the tree branch being viewed.

Browse, scoped search, and journal requests can filter by any selected tag, all
selected tags, or files without an active tag. Tag-aware tree browsing retains
a directory when its subtree contains a matching file. Returned file rows are
hydrated with active tag identities; archived tags are excluded from filtering
and display without deleting their historical assignments.

## HTTP API

The implemented API consists of twenty-six authenticated `POST` routes:

| Area                     | Route                                                   |
| ------------------------ | ------------------------------------------------------- |
| Device list              | `/api/device/list`                                      |
| Unit statistics          | `/api/device/unit-stats`                                |
| Device AOR references    | `/api/device/aors`                                      |
| Device unit references   | `/api/device/units`                                     |
| Device details           | `/api/device/detail`                                    |
| Device creation          | `/api/device/create`                                    |
| Device update            | `/api/device/update`                                    |
| File roots               | `/api/device/files/roots`                               |
| Subtree counts           | `/api/device/files/subtree-counts`                      |
| Direct-child browsing    | `/api/device/files/browse`                              |
| Scoped search            | `/api/device/files/search`                              |
| Synchronization journal  | `/api/device/files/journal`                             |
| File metadata sync       | `/api/device/files/sync`                                |
| Active analytics tags    | `/api/device/analytics/tags`                            |
| Device analytics summary | `/api/device/analytics/summary`                         |
| Tagged-file drill-down   | `/api/device/analytics/files`                           |
| Admin tag list           | `/api/admin/device-analytics/tags/list`                 |
| Admin tag creation       | `/api/admin/device-analytics/tags/create`               |
| Admin tag rename         | `/api/admin/device-analytics/tags/update`               |
| Admin tag archive        | `/api/admin/device-analytics/tags/archive`              |
| Admin tag restore        | `/api/admin/device-analytics/tags/restore`              |
| Admin rule save          | `/api/admin/device-analytics/tags/rule/save`            |
| Admin rule test fixtures | `/api/admin/device-analytics/tags/rule/test-files/list` |
| Admin rule test          | `/api/admin/device-analytics/tags/rule/test`            |
| Global reanalysis        | `/api/admin/device-analytics/reanalyze/all`             |
| Device reanalysis        | `/api/admin/device-analytics/reanalyze/device`          |

Requests use the normal Echo authenticated session. JSON payloads are decoded
strictly; malformed shapes and unsupported fields fail instead of being
silently ignored. Generated backend, Elm, and TypeScript DTOs define the
current wire format.

The seven device routes depend only on the main database. The six device-file
and thirteen analytics routes additionally require `[file_registry]`; when it
is absent, an otherwise authorized request receives HTTP 503 with
`Retry-After`, while the device registry remains available.

Browse, search, and journal accept optional `tag_ids`, `tag_match` (`any` or
`all`), and `untagged` fields. Only active tag IDs are accepted; `untagged` is
mutually exclusive with explicit IDs. Existing endpoint paths and pagination
contracts remain unchanged.

Sync clients must distinguish request-level HTTP errors from ordered per-item
results. They must retain the returned `file_id` for every accepted creation
and use it for subsequent updates or moves. An item without `file_id` is a
non-idempotent create, including a retry after an ambiguous transport outcome;
the server neither deduplicates files by path nor exposes an idempotency-key
protocol. Clients should inspect roots, browse, search, and journal state
before retrying an outcome they could not confirm.

## Authority

This archive records the implemented design of the branch. Current Rust code,
`wd_files` migrations, generated SeaORM entities, generated frontend DTOs, and
tests are authoritative if they differ from this historical description.
