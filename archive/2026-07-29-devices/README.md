# 2026-07-29: Devices module

## Description

The Devices module registers technical sources in Echo, projects their file
metadata into an optional file-registry database, and classifies files with
administrator-defined analytics tags. The registry, synchronization history,
analysis runs, and current analytical result remain queryable through one
authenticated API.

## Architecture

```mermaid
flowchart LR
    Browser["Browser"]
    DeviceSource["External device source"]

    subgraph Host["Echo server"]
        subgraph Backend["wdintel-rs"]
            API["Devices API boundary<br/>/api/device/*<br/>/api/admin/device-analytics/*"]
            Devices["devices/devices<br/>registry and access"]
            Files["devices/files<br/>navigation and synchronization"]
            Analytics["devices/analytics<br/>rules, runs, and results"]
        end

        subgraph Workers["bgworker"]
            ExpiryWorker["file_sync_session_expiry_worker"]
            AnalysisWorkers["file-analysis pool<br/>4 workers"]
        end

        subgraph MainPostgreSQL["wd PostgreSQL"]
            DeviceStore[("device<br/>device_aor")]
        end

        subgraph FilePostgreSQL["wd_files PostgreSQL"]
            FileStore[("file_entry<br/>file_metadata_revision<br/>file_device_source_state")]
            SyncStore[("file_sync_session<br/>file_sync_batch<br/>file_sync_item")]
            AnalysisStore[("file_analysis_definition<br/>file_analysis_run<br/>file_analysis_run_item")]
            TagStore[("analytics_tag<br/>analytics_tag_test_file<br/>device_file_tag")]
        end

        API -->|"registry operations"| Devices
        API -->|"file operations"| Files
        API -->|"analytics operations"| Analytics
        Devices <--> DeviceStore
        Files <--> FileStore
        Files <--> SyncStore
        Files -->|"terminal sync"| Analytics
        Analytics <--> AnalysisStore
        Analytics <--> TagStore
        Analytics --> FileStore
        ExpiryWorker --> SyncStore
        ExpiryWorker -->|"terminal expiry"| AnalysisStore
        AnalysisWorkers <--> AnalysisStore
        AnalysisWorkers -->|"publish current result"| FileStore
        AnalysisWorkers -->|"replace current tags"| TagStore
    end

    Browser -->|"device and admin UI"| API
    DeviceSource -->|"file metadata"| API
```

The main `wd` database owns device identity, organism ownership, AORs, and
units. `wd_files` owns the file projection and every synchronization and
analysis artifact. Authorization is checked against `wd` before file-backed
operations continue in `wd_files`;

| Area | Current model |
| --- | --- |
| Device registry | Organism-scoped devices with source and analytical fields |
| File registry | Cumulative current projection keyed by device and normalized absolute Windows path |
| Synchronization | Automatic calls and resumable explicit sessions with persisted per-item outcomes |
| Analysis | Immutable rule definitions, bounded runs, immutable run items, and a guarded current-result pointer |
| Navigation | Root, tree, search, journal, tag-filtered, and run-history reads |

## Functional records

- [File metadata synchronization](SYNC.md) describes identity, session,
  revision, retry, and analysis-handoff behavior.
- [File analysis](ANALYSIS.md) describes rule snapshots, bounded runs, workers,
  publication, and concurrent-run behavior.

## Access and visibility

| Capability | `Cyber` | `DeviceSource` | `Admin` |
| --- | :---: | :---: | :---: |
| Registry read, create, and source fields | yes | yes | yes |
| Analytical device fields and reference lists | no | yes | yes |
| File navigation, synchronization, and analytics reads | yes | yes | yes |
| Tag administration and manual reanalysis | no | no | yes |

A device is visible to its creating organism and that organism's non-deleted
descendants. Visibility does not flow to parents or siblings. The same scope is
applied before details, file operations, summaries, and analysis-run reads.
Archived devices remain readable when the route explicitly supports them.
Registry-field updates and file synchronization require an active device;
administrators may schedule reanalysis for a visible archived device.

## Deployment

The seven registry routes use only `wd`. The remaining twenty-seven file and
analytics routes require the following optional configuration:

```toml
[file_registry]
pg_host = "postgres-host"
pg_port = 5432
pg_user = "wd"
pg_password = "..."
pg_dbname = "wd_files"
```

When the section is absent, file-backed routes return HTTP `503` with
`Retry-After: 60`; registry routes remain available. When it is present,
connection and migration failures block startup. Provision the database once
with the installed backend binary:

```sh
sudo /usr/bin/wdintel-rs --mode=live oneoff-create-file-registry-database
```

The production bgworker starts the synchronization-expiry worker and the
four-worker analysis pool whenever `wd_files` is configured.

## Authority

This archive describes the implemented Devices design. Current Rust code,
`wd_files` migrations, generated SeaORM entities, generated frontend DTOs, and
focused tests are authoritative when they differ from this record.
