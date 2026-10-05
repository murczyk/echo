# Messenger media delivery

Backblaze/S3 remains the durable store for original attachments. Optional local
retention removes origin latency from the first view of recently published media.
Original URLs keep their original bytes; video playback copies have their own URL.

## Enable local retention

Add this section to the installation's `/etc/echo/config.toml`:

```toml
[messenger_media_cache]
enabled = true
retention_secs = 86400
max_total_size_bytes = 34359738368
min_free_space_bytes = 10737418240
```

Restart the API and background workers through the normal deployment procedure.
Apply `m20261004_175803_signal_message_media_created_at_index` before enabling
recovery, and ensure FFmpeg/ffprobe are installed. The index is built concurrently;
if its build is interrupted, inspect its validity and drop only an invalid
`signal_message_media_created_at_id_idx` before retrying the migration.
Both processes must share the same persistent `storage_dir` and S3 configuration.
Absent or disabled configuration preserves existing media delivery. This feature
supports one application host; multiple processes coordinate through file locks.

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
serves an immutable MP4 playback copy. Both support byte ranges and prevent
shared HTTP caching. Preparing copies return `503` with `Retry-After`; failed
normalization returns `422`. Disabled normalization or unsupported source codecs
redirect to the original URL. Each selected URL keeps one representation during
playback; original downloads never use a remuxed copy.

Playback copies currently support H.264 8-bit 4:2:0 video with optional AAC audio.
FFmpeg copies encoded streams, normalizes H.264 decoder configuration, and moves
MP4 metadata before video data using `+faststart`. The resulting configuration is
checked against its embedded SPS. It does not transcode unsupported codecs or
reduce video bitrate. Adaptive HLS renditions remain a separate improvement for
slow mobile networks.

The browser performs a one-byte readiness request, then streams the video. Each
readiness request times out after 30 seconds; automatic retries stop after two
minutes. A stalled player also exposes recovery controls after 30 seconds.
Blocked autoplay prompts an explicit tap, and playback failures expose Retry,
Open original, and Download controls.

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

To roll back, set `enabled = false` and restart API/background workers. Original
objects and existing media metadata remain compatible. Retained local files can
be removed after stopping the new worker; never remove active cache files or
lock files while their processes are running.

Validation must include range and seek behavior with origin access disabled,
shared-reference retention, concurrent reservations, restart recovery, disk
exhaustion, and real iPhone/Safari playback. Use controlled network conditions
when comparing first-byte and first-frame latency; local retention cannot ensure
that a slow mobile connection can sustain the original video's bitrate.
