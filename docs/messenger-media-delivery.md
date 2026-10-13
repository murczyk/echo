# Messenger media delivery

Backblaze/S3 remains the durable store for original attachments. Optional local
retention removes origin latency from the first view of recently published media.
Original URLs keep their original bytes; video playback copies have their own URL.

## Enable local retention

Open **Адмін → Системні налаштування Neo → Кеш**, enable
**Увімкнути локальний кеш медіа**, and save. The same form controls retention
in hours (minimum 24, default 24), maximum cache size in GiB (default 32), and
reserved filesystem free space in GiB (default 10). Settings use the existing
admin authorization and configuration history. Older settings have caching off.

Changes apply to new uploads and media requests immediately, without editing
configuration files or restarting services. Background recovery reloads settings
at each cycle, starting within 30 seconds when idle. A cycle already in progress
finishes with its settings snapshot; disabling does not interrupt an active file
write. Lower limits do not shorten existing protection or evict protected files.

Apply `m20261004_175803_signal_message_media_created_at_index` and
`m20261005_044401_messenger_media_cache_settings` through normal deployment first,
and ensure FFmpeg/ffprobe are installed. The index is built concurrently;
if its build is interrupted, inspect its validity and drop only an invalid
`signal_message_media_created_at_id_idx` before retrying the migration.
API and background processes must share the same persistent `storage_dir` and
S3 configuration. This feature supports one application host; multiple processes
coordinate through file locks.

Originals and playback copies live in
`<storage_dir>/messenger_media_cache/local`. The directory is private. Protected
originals are retained for at least 24 hours after publication, irrespective of
viewing or the message's event timestamp. Copied references share the same object
and extend its protection. Legacy on-demand cache files remain separate.

Completed immutable uploads can be hard-linked; other sources are copied with
bounded memory. Files are synced and published atomically before upload source
cleanup. Publication metadata survives restarts. Rollbacks discard uncommitted
staging; abandoned staging expires after two hours.
Removing the final database reference also removes retained local copies.

The background worker recovers the recent window in indexed batches. At most two
remote recovery downloads and one playback normalization run across local
processes. Recovery does not postpone message publication. Disk reservations
include in-progress writes; cleanup never evicts protected originals to admit
another file. Disk failure leaves messages accessible from object storage and
logs degraded retention for recovery. The 24-hour guarantee therefore applies
while configured capacity and local storage are healthy.

## Video playback

`GET /api/messenger/media/{id}` serves original bytes, preferring a retained local
file. `GET /api/messenger/media/{id}/playback` checks the same authorization and
selects a playback representation. Plaintext cache misses redirect immediately
to the original byte-range stream; downloading or preparing a complete local
copy never gates them. Ready MP4 copies remain available for ordinary videos.
Encrypted media retains the existing local-decryption readiness flow.

For plaintext MP4s of at least 8 MiB averaging over 8 Mbps, playback redirects to
`/playback/preview.m3u8`. The VOD playlist describes independently seekable
one-second segments. Up to eight seconds are prepared per source connection,
and each completed segment becomes playable immediately. Playback requests also
prepare a short run four seconds ahead, using the same two-worker limit; this
look-ahead stops advancing when the browser stops requesting segments. Generation starts on demand from the retained original when available,
otherwise from a short-lived, server-only signed B2/S3 URL using byte ranges.
No complete original download or whole-video transcode is required. Preview
encoding limits resolution to 720p, frame rate to 30 fps, and video bitrate to
3 Mbps (H.264 with optional AAC audio). Original downloads preserve all bytes
and quality. MP4 inspection failures fall back to ordinary playback.

Every playlist and segment request repeats the original media access checks.
URLs contain no storage credentials, and responses prohibit shared HTTP caching.
The browser lazy-loads hls.js for controlled buffering and retries, falling back
to native HLS on browsers without MediaSource support.
Closing the preview destroys its stream; seeking requests the relevant segment
without downloading the preceding video. A stalled player exposes Retry after
30 seconds, and blocked autoplay prompts an explicit tap.

Preview files live separately under
`<storage_dir>/messenger_media_cache/preview-v1`, with private permissions,
atomic publication, and file locks shared by application processes. At most two
preview jobs run concurrently with two codec threads each. Busy requests return
503 for retry. Probes time out after 5 seconds and segments after 30 seconds;
segments are limited to 8 MiB. New segment generation prunes the preview cache
to a 512 MiB budget with headroom for in-flight jobs and expires day-old files.
The configured retention free-space floor also applies to previews (with a
1 GiB fallback when no retention settings exist). These expendable previews
do not consume the protected-original retention budget.

Playback-copy normalization continues to support H.264 8-bit 4:2:0 with optional
AAC, using stream copy and `+faststart`. It does not reduce bitrate; the separate
preview path handles bandwidth-heavy sources. Unsupported and encrypted formats
continue through their original playback paths.

## Rollout and recovery

Enable on one installation first. Measure the unique bytes in the last 24 hours
and allow headroom for playback copies and other application spools. CBR measured
approximately 6 GiB of unique originals on 2026-10-04; the example budget is
32 GiB with a 10 GiB filesystem floor. Recheck capacity as traffic grows.

Monitor logs for `messenger media retention degraded`,
`missing_protected`, and `video normalization failed`, along with available disk,
origin traffic, and playback latency. The worker logs reconciliation counts and
retries missing originals after storage recovers. Investigation of ingest lag is
separate from this delivery path.

To disable original retention, turn off **Увімкнути локальний кеш медіа** in the
same admin form and save. Preview streaming is independent of that setting.
Roll back preview streaming by restoring the previous backend and frontend
together. Original objects and existing media metadata remain compatible. Retained local files can
be removed after stopping the new worker; never remove active cache files or
lock files while their processes are running.

Validation must include range and seek behavior with origin access disabled,
shared-reference retention, concurrent reservations, restart recovery, disk
exhaustion, and real iPhone/Safari playback. Use controlled network conditions
when comparing first-byte and first-frame latency; local retention cannot ensure
that a slow mobile connection can sustain the original video's bitrate.


Preview regression coverage lives in
`wdintel-rs/src/messenger/media_preview/tests.rs` and
`wdintel-web/tests/e2e/message-card-media-preview.spec.ts` (#3769).
Staging acceptance must measure first frame and sustained playback on a large
cold object, reopen it with warm segments, seek to an uncached position, and
check that closing stops further requests. A cold source still depends on B2
latency and how quickly FFmpeg can decode the source GOP; the original bitrate
and keyframe spacing can affect preparation time.
