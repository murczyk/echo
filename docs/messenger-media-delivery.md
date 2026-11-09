# Messenger media delivery

Backblaze/S3 remains the durable store for original attachments. Optional local
retention removes origin latency from the first view of recently published media.
Original URLs keep their original bytes; video playback copies have their own URL.

## Image thumbnails

Image and video previews are private JPEG files in
`<storage_dir>/messenger_media_cache/thumbnails/<media-id>.jpg`. Newly uploaded
images are queued for thumbnail creation alongside videos. Image previews have a
300 px short side; opening or downloading an image still uses its original S3
object. Missing thumbnails are recovered from the original on request, and an
unsupported or damaged image falls back to its original in the message card.
The worker keeps separate 2 GiB budgets for image and video JPEGs. Temporary
thumbnail sources share a 20 GiB budget and expire after 24 hours.

Historical images can be precomputed on each application host with the bounded
oneoff below. It creates only missing thumbnails and pauses after each image.
Full-history runs scan image rows by UUID. The last ready image is saved in
`delta_kv` under a key scoped to `server_id`; rerunning the command on the same
server resumes automatically. Each server needs its own checkpoint because
thumbnails are local files. Use `--after-media-id` to override it or
`--reset-checkpoint` to restart. Already completed thumbnails are skipped.
Use `--since-date YYYY-MM-DD` to include only media created on or after that UTC
date. Date-scoped runs scan by `(created_at, id)` using the matching database
index and keep separate `delta_kv` keys; pass the same date when resuming. The
command requires the server's unique `server_id` configuration. A date-scoped
checkpoint from the previous UUID ordering restarts from the chosen date so no
images are skipped; already ready thumbnails are reused.
If a thumbnail is still queued or generation fails, the command stops before
checkpointing that image. Inspect its log, then rerun with the same options
after the thumbnail source has been processed or the cause corrected.
`--limit` bounds a run by scanned image rows. Inspect available disk space and the
`thumbnails` and `thumbnail_sources` directories before running it.

```bash
sudo /usr/bin/wdintel-rs --mode=live oneoff-backfill-image-thumbnails --batch-size=50 --pause-ms=250 --limit=1000
sudo /usr/bin/wdintel-rs --mode=live oneoff-backfill-image-thumbnails --batch-size=50 --pause-ms=250
sudo /usr/bin/wdintel-rs --mode=live oneoff-backfill-image-thumbnails --since-date=2026-10-01 --batch-size=50 --pause-ms=250 --limit=1000
```

Run this separately on each host that serves media; thumbnail files are local,
and the command does not change attachment records or original objects.

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
Encrypted media over 10 MiB without a retained copy is decrypted once into that
on-demand cache: decryption covers the whole object, so it cannot serve ranges.

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

### Mobile message-card video viewer

Analysis and Duty share a video viewer that fits mobile footage to the whole
available browser viewport without cropping or forcing orientation. Its background
uses the same theme surface as other attachments. The translucent mobile playback
panel and carousel island use that surface too, with controls coloured by the theme.
The header,
playback controls, and attachment navigation overlay the video without reserving
layout height. Rotating a phone to landscape automatically fits the video to the
new viewport, keeping the same video element, playback position, mute, and speed.

A tap or click on the video toggles the header and controls together, while playing
or paused; it does not play, pause, zoom, close, or request fullscreen. Playback has
a separate button. Controls initially hide after two seconds of playback, except
during loading, errors, menu interaction, keyboard focus, and report editing.
Manual taps cancel that timer. Enter/Space on the focusable video toggles the same
panels without changing playback. The shared attachment header preserves filename,
information, file actions, close, and carousel spacing. Playback speed is in its
overflow menu. Horizontal swipes and shared carousel controls retain the message's
mixed attachments. The mobile playback panel uses one row from 480px wide, or a
timeline above the buttons on narrower screens, without a duplicate centre button.
On narrow screens, carousel navigation sits in a translucent island above the
playback panel. At the initial zoom, a vertical swipe on the mobile video surface
dismisses the viewer, including standard fullscreen, and stops playback. Timeline
and button gestures keep their own actions; fullscreen still blocks horizontal
attachment navigation. Desktop background clicks outside the video still dismiss
the viewer. The panel stays anchored to the bottom for one or many attachments.
While the mobile video viewer is open, it temporarily sets `viewport-fit=cover`
so supporting browsers can extend its background underneath gesture navigation.
The shared dialog owns this setting and keeps it unchanged while switching
between photos and videos, avoiding repeated browser viewport resets.
The playback buttons remain above the bottom safe-area inset. Closing the viewer,
switching to an attachment other than an image or video, or returning to desktop
controls restores the previous viewport settings. Browsers may still draw their own system bar;
fullscreen exit banners remain controlled by the browser.

The mobile playback panel includes a fullscreen button when the platform supports
it; it becomes available after video metadata loads. On Android with the standard
Fullscreen API, it expands the document containing the player and its portalled
menus, preserving our controls. The same button exits fullscreen. While fullscreen
is active, attachment navigation is hidden and horizontal swipes and arrow keys cannot change slides;
exiting restores normal attachment navigation. Escape or the
browser's fullscreen exit returns to the open viewer. In portrait fullscreen,
the header adds minimum top and side spacing to the system safe-area insets.
Entry failures show a toast. Exiting fullscreen remains available while the video
element is absent during loading or after a failed retry.
Leaving the video viewer releases its fullscreen, including late requests after
closing; returning retains the same video element, position, mute, and speed.

On iPhone without element fullscreen support, the button invokes WebKit's native
video fullscreen, enabling system controls before entry. Apple controls replace
our UI there. Exiting restores our inline controls without reloading the video.
The inline viewport layout can retain browser bars; rotating alone never requests
fullscreen. Device-file playback keeps its existing behavior.

Browser regressions: `wdintel-web/tests/e2e/message-card-video-mobile.spec.ts`
(#3340). Chromium emulation does not replace physical Android Chrome and iPhone
Safari acceptance, including fullscreen entry/exit, native controls, browser bars, safe areas,
rotation, and the onscreen keyboard.

### Mobile message-card image viewer

Mobile image previews share the video's temporary edge-to-edge opt-in. Without
OCR, summary or report panes, the zoom stage fills the viewport. The header
overlays the stage and respects the top and side safe-area insets. At 100%, the
image fits between equal top and bottom insets, each exactly the measured header
height including its top safe area. Aspect-ratio fitting can add letterboxing
when image width is the limiting dimension. These insets limit the
image's initial dimensions, not the zoom stage: zoom and pan can use the whole
viewport. On narrow screens, a
translucent themed carousel island overlays the stage,
16px above the bottom safe area, instead of reserving a full-width footer. A single
attachment has no island. Wider screens retain the header's carousel controls.
With OCR or report panes open, the island stays inside the source image area.
Single taps or clicks on the mobile image surface toggle the header and island
together without changing zoom. Hiding the panels preserves the image size and
position. With OCR, summary or report panes open, the header reserves its own
space so pane actions remain accessible; hiding it releases that space. Full-pane OCR keeps
the header visible when the source image is hidden. Enter/Space on the focusable
image performs the same action. Double touch taps, pinch, wheel zoom, pan, swipe,
editing, and OCR/report actions retain their existing behavior. New attachments
start with the controls visible. Desktop image-click zoom remains unchanged.
Entering the image editor restores the previous viewport settings.

Browser regressions: `wdintel-web/tests/e2e/message-card-image-mobile.spec.ts` (#3340).
The gesture navigation bar's final appearance still requires physical-device acceptance.

### Other mobile message-card attachments

Documents, spreadsheets, archives, audio and coordinate/KML/KMZ maps use the same
mobile theme surface, viewport opt-in and header safe areas. Attachment navigation
floats in a translucent island instead of a full-width bottom bar; one attachment
has no island. Map controls and spreadsheet sheet buttons keep their own actions,
with the island above them. Leaflet bottom controls are offset above the gesture
safe area. Desktop layouts retain their existing behavior.

ZIP statistics and file listings start below the measured mobile header with a
small gap and retain trailing clearance above the navigation island.

Single surface taps or Enter/Space on the focused preview region toggle the
header and island without resizing the content. Buttons, links, spreadsheet
selection, text selection, scrolling, map markers, map gestures and audio playback
retain their own actions. New attachments start with panels visible. Audio previews
without vertical overflow dismiss on vertical surface swipes and stop playback,
matching images and videos. Scrollable audio, player controls, transcription
selection and report panes retain their own gestures. Scrollable content has
initial header clearance and enough trailing space to reach its last lines above
the island and system gesture area. OCR, summary and report panes keep the header
in the layout so their actions remain reachable.

At the initial document zoom, a new downward swipe starting at the top or an upward
swipe starting at the bottom dismisses the mobile viewer. The scroll positions of
all containers under the initial touch must allow that direction; a gesture that
merely reaches an edge continues scrolling. Short drags settle back. Text selection,
interactive controls, zoomed documents and open OCR/summary/report panes retain
their gestures. This applies to PDF, DOCX, text, office documents, spreadsheets and
ZIP listings. Mobile previews block scroll chaining to browser page refresh; DOCX
registers the same touch handlers inside its existing sandboxed iframe and contains
overscroll on the iframe document's root and body. Desktop behavior is unchanged.

DOCX enables `allow-same-origin` on mobile so the parent can observe iframe taps
and preserve selection and scrolling. Scripts remain blocked by both the sandbox
and CSP; sanitization and external-resource restrictions stay in place. Insets
are applied inside the iframe without resizing it when panels hide. Desktop
keeps the opaque sandbox.

Browser regressions: `wdintel-web/tests/e2e/message-card-attachments-mobile.spec.ts` (#3340).
