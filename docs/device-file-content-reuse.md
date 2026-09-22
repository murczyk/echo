# Reusing verified Device file content

A successful FileSync item creates a new metadata revision and clears its
current content pointer. This still happens when the bytes have not changed.
A source that knows the new revision has exactly the bytes of an earlier,
completed upload can now publish that immutable object again without TUS PATCH
or another storage write. Matching paths or timestamps alone are insufficient:
the caller must retain the original upload receipt, byte count and SHA-256,
and establish the same byte identity for the new metadata revision.

## Authentication and capability

Use the normal authenticated Echo session cookie. The login must be active,
belong to an organism, and have `Cyber`, `DeviceSource` or `Admin`; Devices must
be enabled. A reuse request also checks current FileSync access to its device.

`OPTIONS /api/device/file-content-reuse` returns `204` and
`Echo-Content-Reuse: 1` when this API supports reuse and its content runtime and
`wd_files` migration are available. It requires authentication, but does not
require `Tus-Resumable`. This is a capability check, not an object-store health
test. Older servers do not advertise this capability. Clients that rely on
reuse before deleting local copies must wait for a positive response.

## Publish a verified object for a new revision

```http
POST /api/device/files/{device_id}/{file_id}/revisions/{revision}/content-reuse
Content-Type: application/json
Tus-Resumable: 1.0.0
Cookie: <authenticated session>

{"source_upload_id":"<original upload UUID>","expected_size":123,"expected_sha256":"<64 lowercase hexadecimal characters>"}
```

The JSON body is limited to 1024 bytes. `expected_size` is the unencrypted
source byte count. SHA-256 identifies those source bytes, not encrypted storage
bytes. For an empty file use the SHA-256 of the empty byte string. The original
upload must be completed, refer to this exact device and file, and have an
earlier revision. This API cannot reuse another file's content or a merely
fully received but uncompleted upload.

Success is `200` with this explicit receipt:

```json
{
  "status": "reused",
  "device_id": "<device UUID>",
  "file_id": "<file UUID>",
  "revision": 2,
  "source_upload_id": "<original upload UUID>",
  "source_revision": 1,
  "size": 123,
  "sha256": "<64 lowercase hexadecimal characters>"
}
```

Persist and verify the complete receipt. Its `source_upload_id` remains the
original TUS upload; reuse creates no new upload UUID. `/complete` on that
original upload continues to return its original revision. Further metadata
revisions may reuse the same original upload directly.

Publication and its immutable revision binding commit in one transaction.
Repeat the same POST after a timeout, connection loss or
`503 publication_outcome_unknown`. Once that binding exists, replay returns
the same receipt even if newer metadata arrived meanwhile; it never restores
an old content pointer over newer metadata. Without an existing binding,
publication is allowed only for the current revision. Concurrent identical
requests converge on one binding.

| Response | Meaning and recovery |
| --- | --- |
| `400 invalid_reuse_request` | Invalid JSON, unknown fields, UUID, size or digest format; correct the request. |
| `401` / `403` | Authenticate again or restore the required access. |
| `404 not_found` | Target or source is absent or the source belongs to a different device/file. |
| `409 content_not_verified` | The original upload has no verified completed publication. |
| `409 content_identity_mismatch` | Expected bytes do not match the original publication; upload the actual new bytes. |
| `409 invalid_source_revision` | The source revision is not older than the target. |
| `409 revision_stale` | The target is no longer current and has no matching persisted reuse binding. |
| `409 content_already_committed` | A different publication already owns the target revision. |
| `409 upload_in_progress` | The target has an open TUS upload; finish or terminate that attempt first. |
| `412` / `415` / `413` | Correct the TUS version, content type or JSON body length. |
| `422 sha256_mismatch` | A zero-byte request contains a nonempty-file digest. |
| `503` | Retry the same request with backoff and any returned `Retry-After`. |

## Storage, migration and rollout

`m20260915_212032_reuse_verified_file_content` changes only the separate
`wd_files` database. Each target `(file_id, revision)` gets its own immutable
`file_content` row referencing the same original upload and object. The new
foreign key verifies file, object, size and digest; an insert trigger additionally
requires completed original provenance and identical encryption state. No
metadata inventory reset, historical `file_entry` rewrite or object copy runs.
The migration creates indexes on the content/upload tables and takes their DDL
locks; allow the normal migration window. These tables are outside the primary
database's PeerDB analytics mirror.

Deploy the API and background worker from the same version, with the migration,
before enabling clients that discard completed payloads. Existing TUS clients
continue to work. Revision read/download APIs resolve the requested revision's
binding and existing object, including published historical revisions selected
through [synchronization sessions](device-sync-sessions.md). Cleanup retains
referenced objects; reuse does
not reserve upload quota, allocate spool bytes or probe storage availability.

Do not downgrade to the older API after reuse begins: it assumes one content
row per upload when returning completion receipts. The down migration refuses
while reused revisions exist. Stop reuse clients and repair forward; do not
delete immutable bindings or storage objects to force a downgrade.
