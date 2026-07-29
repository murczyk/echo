# 2026-07-29: Devices module

## Outcome

Echo now has a Devices module for registering technical sources, maintaining
analytical metadata, and synchronizing file metadata. The backend, generated
DTOs, and frontend described here replaced the planning documents that guided
the implementation.

The module is a metadata registry. It does not ingest file contents, control
remote equipment, or provide a general-purpose file manager.

## Storage boundaries

Device and file metadata are intentionally stored in separate PostgreSQL
databases:

- the main Echo database stores `device`, `device_aor`, ownership, lifecycle,
  and analytical relations;
- the independent `wd_files` database stores the `file_entry` hierarchy and
  file synchronization history.

Backend services use typed `MainDb` and `FileRegistryDb` wrappers so a query
cannot accidentally run against the wrong connection. There are no cross-
database foreign keys or transactions. A file-registry request first validates
the device and the actor against the main database, then performs the isolated
file-registry operation.

Both databases have independent migration histories. Main migrations do not
create `wd_files`; its schema migrations run automatically during backend
startup after the database has been provisioned.

## Deployment

Provision the file-registry database before the first restart of the server or
background worker. Configure these values in `deploy/config.toml`, or in the
TOML file selected through `ECHO_CONFIG_PATH`:

```toml
pg_wdfile_host = "postgres-host"
pg_wdfile_port = 5432
pg_wdfile_user = "wd"
pg_wdfile_password = "..."
pg_wdfile_dbname = "wd_files"
```

Create the database once with the same live configuration used by the backend:

```sh
just create-file-registry-database --mode=live
```

The configured PostgreSQL user needs `CREATEDB` for this provisioning command
and normal DDL permissions for the automatic `wdfiles-migration` startup
migrations. If operations provisions `wd_files` manually instead, the configured
user still needs connection and DDL rights before Echo is restarted.

Test environments use a paired file-registry database, normally
`wd_files_test`, selected with `TEST_WDFILE_DB_NAME`.

## Access and organization visibility

Backend authorization is the source of truth. The effective capabilities are:

| Role | Read | Source data and file sync | Analytical data |
| --- | :---: | :---: | :---: |
| `Cyber` | yes | no | no |
| `DeviceSource` | yes | yes | no |
| `DeviceAnalyst` | yes | yes | yes |
| `Admin` | yes | yes | yes |

Every device stores the organization of the user who created it. A user can see
devices owned by their own organization and by every non-deleted descendant at
any depth. Visibility does not flow upward or sideways: a child organization
cannot see its parent or siblings. The same predicate protects lists, details,
updates, statistics, and file-registry handoffs.

Archived devices remain available to read paths that explicitly include
archived records, including file metadata. Source and analytical writes require
an active device.

## Device ownership and lifecycle

Source-owned fields identify the technical source and its connection metadata.
Analytical fields hold the analyst-assigned name, unit, areas of responsibility,
and other classification. A source user cannot create or modify analytical
metadata. Analyst and administrator roles can maintain both groups when an
operation intentionally combines them.

Creation records both the creator login and creator organization. Updates use
field-level patches, validate the caller's capabilities before writing, and
apply combined source and analytical changes atomically in the main database.
Source labels are unique among active devices. Archived devices do not reserve
active-only uniqueness.

The backend contains lifecycle rules for active and archived devices, but the
public Devices API currently exposes neither archive nor restore endpoints.

## File hierarchy

`file_entry` uses UUID identifiers, a parent relation, and a PostgreSQL `ltree`
hierarchy path. Each device can have independent POSIX and Windows roots. Exact
absolute paths are retained while normalized keys provide deterministic
matching, uniqueness, and ordering.

Directories are virtual metadata derived from synchronized paths. Public sync
requests submit files; the service creates missing directory chains and updates
or inserts file leaves. Directory mutation is not a public API.

Synchronization is cumulative rather than snapshot replacement. Omitting a
previously synchronized path does not delete or hide it. Each accepted file
updates its current metadata and synchronization timestamp. Repeating a path
reconciles the existing entry instead of creating a duplicate.

A batch is processed as ordered independent items inside the synchronization
contract. The response preserves request order and can contain both accepted
and rejected results. Validation failures do not discard successful siblings.
Database failures that invalidate the transaction are classified explicitly so
clients can retry the affected input after rollback.

File counts are exact and computed dynamically. The journal uses an indexed
exact device count; tree expansion groups an indexed `ltree` subtree scan by
the requested roots or directories. Counts are loaded only for the journal or
the tree branch being viewed.

## HTTP API

The implemented API consists of eleven authenticated `POST` routes:

| Area | Route |
| --- | --- |
| Device list | `/api/device/list` |
| Unit statistics | `/api/device/unit-stats` |
| Device details | `/api/device/detail` |
| Device creation | `/api/device/create` |
| Device update | `/api/device/update` |
| File roots | `/api/device/files/roots` |
| Subtree counts | `/api/device/files/subtree-counts` |
| Direct-child browsing | `/api/device/files/browse` |
| Scoped search | `/api/device/files/search` |
| Synchronization journal | `/api/device/files/journal` |
| File metadata sync | `/api/device/files/sync` |

Requests use the normal Echo authenticated session. JSON payloads are decoded
strictly; malformed shapes and unsupported fields fail instead of being
silently ignored. Generated backend and frontend DTOs define the current wire
format.

Sync clients must distinguish request-level HTTP errors from ordered per-item
results. They should retain failed source records, retry only records that were
not accepted, and reconcile state through roots, browse, search, and journal
reads. The server does not expose a separate idempotency-key protocol; exact
normalized paths provide synchronization identity.

## Frontend

The user-facing module provides:

- `/devices` for organization-scoped listing, filtering, creation, and editing;
- `/devices/:id` for analytical details, file-tree browsing, subtree counts,
  search, and synchronization journal inspection.

Elm route wrappers host React custom elements. React uses the generated API
bindings and the same backend authorization model; frontend visibility is not a
security boundary.

## Deliberate exclusions

The completed stage does not provide:

- file-content upload, storage, download, or preview;
- public directory create, move, rename, or delete operations;
- file hide, restore, or permanent deletion endpoints;
- public device archive or restore endpoints;
- snapshot replacement semantics;
- file analytics or content processing;
- server-issued idempotency keys.

These exclusions keep technical synchronization separate from analytical
classification and leave content handling to a future, explicit contract.

## Source of truth

This archive records the implementation outcome and deployment constraints as
of 2026-07-29. It is not an active staged plan. Backend code, database
migrations, generated DTOs, and current API tests are authoritative when they
differ from this historical summary.
