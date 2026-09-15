# File metadata synchronization

## Contract


| Input | Behavior |
| --- | --- |
| Path | Trims outer whitespace and uppercases the drive letter |
| Unsupported path | Rejects relative, POSIX, device, extended-length, empty-component, `.` and `..` paths |
| Existing normalized path | Updates the same server-owned file |

Every accepted item, atomically:

1. updates `file_entry`, the current projection;
2. appends one immutable `file_revision`;
3. increments the file revision and the device-wide source sequence;
4. records the terminal item outcome.

An accepted metadata revision clears current content even when bytes are
unchanged. The source may explicitly republish an earlier verified object via
the [content reuse API](../../docs/device-file-content-reuse.md), with the
original upload UUID, exact size and SHA-256. A separate immutable binding
records the new revision; replay of an old binding cannot overwrite newer
metadata. Normal TUS publication remains available for changed bytes.

## Flow

```mermaid
flowchart LR
    Caller["Device source"] --> API["Devices file API"]

    subgraph Echo["Echo server"]
        API --> Normalize["path and metadata validation"]
        API --> Sessions[("file_sync_session<br/>file_sync_batch<br/>file_sync_item")]
        Normalize --> Mutation["revision mutation"]
        Mutation --> Projection[("file_entry<br/>current projection")]
        Mutation --> Revisions[("file_revision<br/>immutable history")]
        Mutation --> SourceState[("file_device_source_state<br/>per-device sequence")]
        Expiry["file_sync_session_expiry_worker"] --> Sessions
        Sessions -->|"completed or expired"| Handoff["analysis-run handoff"]
        Handoff --> Runs[("file_analysis_run")]
    end
```

One device can have only one open synchronization session. An automatic call
therefore conflicts with an open explicit session, and starting an explicit
session while another explicit session is open returns that existing session.

## Automatic synchronization

`POST /api/device/files/sync` is the bounded one-shot mode. The session, batch,
item outcomes, file mutations, immutable revisions, terminal session state, and
optional analysis run commit in one `wd_files` transaction.

```mermaid
sequenceDiagram
    participant Client
    participant API as POST /api/device/files/sync
    participant DB as wd_files transaction
    participant Analysis as analysis handoff

    Client->>API: device_id + 1..1000 files
    API->>DB: create automatic session and batch 0
    loop Request order
        DB->>DB: validate item
        alt Valid and first path occurrence
            DB->>DB: upsert projection + append revision + accept
        else Invalid or duplicate path in session
            DB->>DB: persist rejected outcome
        end
    end
    DB->>DB: finalize batch and session
    DB->>Analysis: create run only if evaluator input changed
    DB-->>API: commit
    API-->>Client: terminal sync summary + ordered results
```

A deterministic item error is a partial success and does not discard accepted
siblings. An infrastructure failure rolls back the entire automatic call.

## Explicit synchronization

Explicit sessions support restart-safe producers. They have a fixed three-hour
lifetime from creation and accept batches strictly in ascending zero-based
order.

```mermaid
sequenceDiagram
    participant Client
    participant API as Devices file API
    participant DB as wd_files
    participant Expiry as expiry worker

    Client->>API: POST /sync-session { device_id }
    API->>DB: create or load the device's open explicit session
    API-->>Client: 201 for new, 200 for existing

    loop batch_index = next_batch_index
        Client->>API: POST /batches/{batch_index} { files }
        alt Batch is new
            API->>DB: persist the request items
        else Batch already exists
            API->>DB: load the first persisted request body
        end
        API->>DB: apply every still-pending item transactionally
        API->>DB: finalize batch and advance next_batch_index
        API-->>Client: sync + batch summaries + ordered results
    end

    alt Producer completes before expiry
        Client->>API: POST /complete { expected_batch_count }
        API->>DB: verify count, finalize session, create analysis run if needed
        API-->>Client: completed or completed_with_errors
    else Fixed lifetime elapses
        Expiry->>DB: mark session expired and create analysis run if needed
    end
```

The first body persisted for `(sync_id, batch_index)` is authoritative. A replay
of that batch resumes or returns its persisted work; a different body on the
replay does not replace it. Completion is idempotent only when
`expected_batch_count` equals the already finalized count.

`POST /api/device/files/sync-session/{sync_id}/items` pages persisted terminal
outcomes by `(batch_index, item_index)`. It is the recovery source after a lost
HTTP response. Expiry preserves terminal outcomes and does not invent outcomes
for items that were never applied.

## Session and batch states

```mermaid
stateDiagram-v2
    [*] --> Open
    Open --> Completed: terminalized with no rejected items
    Open --> CompletedWithErrors: terminalized with rejected items
    Open --> Expired: fixed TTL elapsed
    Completed --> [*]
    CompletedWithErrors --> [*]
    Expired --> [*]
```

| Object | States |
| --- | --- |
| Session | `open`, `completed`, `completed_with_errors`, `expired` |
| Batch | `processing`, `applied`, `applied_with_errors` |
| Item | pending internally, then `accepted` (`created` or `updated`) or `rejected` |

## Analysis handoff

File revisions and analysis-input revisions are deliberately separate. MIME
type, timestamps, and source state still create a metadata revision, but they
do not require classification again.

```mermaid
flowchart TD
    Accepted["Accepted file mutation"] --> Revision["append metadata revision<br/>advance source sequence"]
    Revision --> Changed{"Evaluator input changed?"}
    Changed -->|"no"| Keep["retain previous analysis_input_revision"]
    Changed -->|"yes"| Advance["analysis_input_revision = new revision"]
    Keep --> Terminal{"Session terminal?"}
    Advance --> Terminal
    Terminal -->|"no"| Wait["wait for completion or expiry"]
    Terminal -->|"yes"| Needed{"Session contains a new evaluator input?"}
    Needed -->|"no"| NoRun["no analysis run"]
    Needed -->|"yes"| Run["create at most one run bound to sync_id"]
```

Evaluator input consists of the file name without its final suffix, directory
path, full path, and extension. [File analysis](ANALYSIS.md) describes how the
run snapshots and publishes those results.

## Failure and retry semantics

| Outcome | HTTP behavior | Retry rule |
| --- | --- | --- |
| Item validation failure | `200`, item is `rejected` with `validation` and field errors | Do not retry unchanged input |
| Path already accepted in the same session | `200`, later item is `rejected` with `duplicate_path_in_session` | Send the path in a later session if needed |
| Invalid top-level batch or query | `400` | Correct the request |
| Session/order conflict | `409` with stable `code` and `message` | Read session state, then resume the expected operation |
| File registry unavailable | `503` with `Retry-After: 60` | Retry after configuration or service recovery |
| Infrastructure or uncertain commit | `500` | Automatic mode has no replay identity, so a retry is a new mutation if the first call committed; explicit callers first read status and outcomes, then replay the same batch identity |

Explicit conflict codes are `active_session`, `wrong_next_batch`,
`terminal_session`, `complete_mismatch`, and `batch_processing`.

## Limits

| Boundary | Limit |
| --- | --- |
| Files per automatic call or explicit batch | `1..1000` |
| Open explicit lifetime | 3 hours, not extended by activity |
| Outcome page | default 100, maximum 100 |
| Expiry claim | up to 100 sessions per tick |
| Expiry idle poll | 60 seconds |

Path and metadata size limits are enforced at item validation and reported in
`field_errors`; the wire shapes are listed in [HTTP API](API.md).

## Authority

The synchronization implementation is in
`wdintel-rs/src/devices/files/sync/`, with wire types in
`wdintel-rs/src/devices/files/types.rs` and schema in `wdfiles-migration` plus
`wdintel-rs/src/file_registry/entities`. Current code, migrations, generated
DTOs, and focused synchronization tests are authoritative.
