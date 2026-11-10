# Media processing

How Echo receives, stores, transforms and serves media: images, video, audio,
documents and archives. It covers messenger attachments and Device files, the
two paths that accept files from outside parties. The companion audit checklist
is [media-security-audit-checklist.md](media-security-audit-checklist.md).

Every byte in these paths is untrusted. A messenger attachment comes from any
remote sender who can reach a monitored chat, and a Device file comes from a
synchronised device.

## Overview

```text
 Signal / WhatsApp            Collectors (Telegram etc.)      Devices (FileSync, audio)
 signal-cli-rest-api,         messenger ingest API            TUS uploads
 whatsapp-cli (echo-im)       TUS + attachments/submit        /api/device/...
        │                            │                              │
        ▼                            ▼                              ▼
 attachment file on disk ──► messenger::media::store_media_attachments    device content finaliser
                              type detection, encryption decision          strong-box encryption, readback
                                     │                                      │
                                     ▼                                      ▼
                          S3 / Backblaze B2 (originals)           S3 (wd_files content objects)
                                     │                                      │
            ┌────────────────────────┼─────────────────────┐                │
            ▼                        ▼                     ▼                ▼
   local retention cache   derived media (ffmpeg)   extraction / OCR   archive helper, geodata,
   + playback copies       thumbnails, HLS preview, echo-document-     documents, audio rendition,
                           waveform, spectrogram    extractor, GPU     transcription
                                     │              transcription
                                     ▼
                     HTTP routes (/api/messenger/media/..., /api/device/files/...)
                                     │
                                     ▼
                     browser viewers (img, video+hls.js, PDF.js, DOCX/XLSX/DOC/XLS
                     workers, KMZ map, ZIP tree)
```

## Ingestion

### Signal and WhatsApp

- `signal-cli-rest-api` (`echo-signal-bot@` unit) and `whatsapp-cli`
  (`echo-whatsapp-bot@` unit) download attachments to disk:
  `/etc/echo/{signal|whatsapp}-cli-data/<client>/...`.
- `echo-im` (git dependency) records each file in `echo_attachment`.
  - The path is `signal_api_attachment_path.join(attachment.id)`
    (`echo-im/crates/echo-im/src/signal/sync_inbox.rs`
    `save_attachment_restapi`).
  - The file name is the sender's original file name.
- The messenger worker (`wdintel-rs/src/messenger/worker/`) reads these rows.
  It passes `MediaUploadInput { path, name, content_type: None }` to
  `messenger::media::store_media_attachments`.

### Messenger ingest API (collectors)

- Collectors upload bytes with TUS first: `/uploads`, 6 GiB per file, unfinished
  uploads expire after 4 h.
- They then call `POST /messages/attachments/submit`
  (`wdintel-rs/src/messenger_ingest/attachments.rs` `submit_attachments`), with
  at most 20 attachments per request.
- A collector may send `content_type`, which overrides the TUS `filetype`.
  Telegram `file_id` and `media_type` are kept as metadata.
- Avatars use their own path (`messenger_ingest/avatars.rs`): 20 MiB, an image
  content-type allowlist, and no previews, OCR or transcription.
- Contract details: [MESSENGER_INGEST.md](MESSENGER_INGEST.md).

### Storing attachments

All of this is in `wdintel-rs/src/messenger/media.rs`.

1. **Open.** `prepare_attachment` opens the source with
   `O_NOFOLLOW | O_NONBLOCK` and requires a regular file. It reads a 16 KiB
   probe.
2. **Sniff the type.**
   - `probed_content_type` uses the `infer` crate.
   - It also has its own MPEG-TS sync-byte check, which detects 188, 192 and
     204-byte packets.
3. **Resolve the type.** `resolve_attachment_content_type` decides the stored
   `content_type`:
   - A declared `audio/*`, `image/*` or `video/*` type, or one of the excluded
     video types, is kept as declared.
   - Any other non-generic declared type is also kept, unless the sniffed type
     is an excluded video.
   - Otherwise the result is the sniffed type, then a `mime_guess` lookup by
     file name or path, then `application/octet-stream`.
4. **Encrypt or not.**
   - Files up to 100 MiB are encrypted with `strong-box`, keyed by
     `s3_config.strongbox_key`.
   - Larger files, and video containers on the excluded list (`config.rs`
     `MESSENGER_MEDIA_ENCRYPTION_EXCLUDED_*`), are stored as plaintext so they
     can be streamed by byte range.
5. **Upload.** The object goes to S3 or B2 through `opendal`
   (`storage::upload_*_to_s3_with_operator`). A row is written to
   `signal_message_media`.
6. **Hand off.** Stored attachments enter the derived-media pipeline below.
   Operator attachment replacement accepts only JPEG, PNG or WebP. The sniffed
   type, the declared type and the extension must all agree
   (`validate_replacement_image`).

### Device files

- **Content files** arrive as a normal TUS upload, then a sync or async
  finalisation
  ([device-upload-finalization.md](device-upload-finalization.md)).
  - Content is encrypted with `strong-box` and read back from S3 before it is
    published.
  - Rows are written to `wd_files`.
  - Identical bytes can be republished without a new upload
    ([device-file-content-reuse.md](device-file-content-reuse.md)).
  - The device client supplies the MIME type and stores it with the file.
- **Device audio** (`wdintel-rs/src/devices/audio/`) accepts only WAV and MP3,
  from 1 B to 100 MiB.
  - Each file is fully decoded with `ffmpeg -xerror -err_detect explode` and
    `-protocol_whitelist file,pipe` before it is accepted (`probe.rs`
    `decoder_command`).
  - The bytes are stored as one encrypted S3 object.

## Storage

| Data | Location | Protection |
| --- | --- | --- |
| Messenger originals | S3/B2 bucket, key from `media_object_key` | strong-box if ≤ 100 MiB and not an excluded video; plaintext otherwise |
| Device file content | S3 (`file_content`) | strong-box, AAD `bucket/full-key` |
| Retained originals, playback copies | `<storage_dir>/messenger_media_cache/local` | dirs `0700`, files `0600`, file locks |
| Image/video thumbnails | `<storage_dir>/messenger_media_cache/thumbnails/<id>.jpg` | `0700`/`0600` |
| Device file thumbnails | `/tmp/echo-device-file-thumbnails` | 1 GiB budget, 24 h TTL, `0700`/`0600` |
| Thumbnail sources | `<storage_dir>/messenger_media_cache/thumbnail_sources` | 20 GiB budget, 24 h TTL |
| HLS preview segments | `<storage_dir>/messenger_media_cache/preview-v1` | 512 MiB budget, 24 h TTL |
| Waveform/spectrogram PNG | `/tmp/wave-<id>.png`, `/tmp/spectrogram-<id>.png` (`MESSENGER_MEDIA_AUDIO_PNG_TMP_DIR`) | system `/tmp` |
| ZIP archive work | `<storage_dir>/device-file-archive` | private attempt directories |
| Outbound chat media (echo-messengers) | `/var/lib/echo-messengers/chat-attachments` | service-owned |
| Extraction/OCR results | `wd` / `wd_files` tables, encrypted artifacts | sanitized HTML |

## Derived media and processing

| Job | Input | Component | Code | Limits and flags |
| --- | --- | --- | --- | --- |
| Image/video thumbnail | messenger image or video; Device file image or video | `ffmpeg` (mjpeg out) through [`echo-media`](../echo-media/README.md) | `thumbnail.rs` `generate`, called by `messenger/media_thumbnail.rs` and `devices/files/content/thumbnail/source.rs` | `-protocol_whitelist file` and a demuxer whitelist (`ECHO_MEDIA_FORMATS_THUMBNAIL`); sandboxed child; 120 s timeout, 1 decoder and encoder thread, `-map 0:v:0`; one messenger generation at a time; Device output ≤ 2 MiB |
| Playback normalisation | H.264 yuv420p MP4 (+AAC) | `ffprobe`, `ffmpeg -c copy +faststart` | `messenger/media_local_cache/playback.rs` | `-protocol_whitelist file,pipe`; 5 min timeout |
| HLS preview | plaintext MP4 ≥ 8 MiB, > 8 Mbps | `ffprobe`, `ffmpeg` libx264/aac, `hls.js` in browser | `messenger/media_preview/{source,mod}.rs` | input is a local file or a pre-signed S3 URL (10 min TTL); `-protocol_whitelist file,http,https,tcp,tls -format_whitelist mov`; 5 s probe, 30 s segment, 8 MiB per segment, 2 jobs |
| Waveform, spectrogram | encrypted messenger audio | `milgeo-audio-wave` → `ffmpeg` | `messenger/media_wave.rs` | temp file plus PNG in `/tmp`; **no protocol whitelist** |
| Transcription probe | message and device audio | `ffprobe` | `transcription/worker.rs` | 100 MiB plaintext cap; **no protocol whitelist** |
| Transcription | audio | `echo-gpu-client` → GPU host queue | `transcription/`, [transcription.md](transcription.md) | native queue in `wd` |
| Device audio rendition, wave | WAV/MP3 | `ffmpeg` libmp3lame | `devices/audio/content.rs` `media_command` | `-protocol_whitelist file,pipe`, `-xerror` |
| OCR | PDF, JPEG, PNG attachments | `echo-document-extractor` (PaddleOCR, pypdfium2, Pillow, NuExtract3/Gemma via router) | `ocr/worker.rs`, `ocr/package.rs` | source ≤ 250 MiB; result ZIP ≤ 1,000 entries and ≤ 250 MiB declared; HTML sanitized with `ammonia` |
| Attachment indexing | Office, PDF, text, CSV, JSON, XML/HTML, archives | `echo-document-extractor` native API (LibreOffice in bubblewrap with seccomp, libarchive, python-docx/pptx, openpyxl, lxml) | `attachments/worker.rs`, [attachments README](../wdintel-rs/src/attachments/README.md) | 1,000 members, 2 archive levels, 1 GiB expanded, 250 MiB per input |
| Device document indexing | Device file content | same extractor; KML/KMZ through Echo's parser | `devices/documents/` | shared bounds |
| ZIP tree (Device) | ZIP | `zip` crate in a child helper process | `devices/files/archive/` | 10 GB, 1000:1 ratio, 10,000 nodes, 8 nested levels, attempt timeout 4 h |
| Map conversion | GPX, GeoJSON, LDK, TRK, ... | Alpine conversion service over HTTP | `alpine/mod.rs`, `sigint/media_conversion/` | result is KMZ |
| KML/KMZ, XLSX import | map and report files | `quick-xml`, `zip`, `calamine`, `geoconvert` | `kml/`, `rer_importer/`, `palitra/` | — |
| AI-agent uploads | PNG, JPEG, WebP, PDF | `image` crate (jpeg/png/webp), `infer` | `ai_agent/uploads/` | own limits |

Thumbnail ffmpeg processes run through `echo-media`. Each gets a cleared
environment and no capabilities. Landlock limits it to reading system libraries
and its input, and writing only a private job directory. Offline jobs run in
their own network namespace when the service is root. The other ffmpeg rows
above still spawn ffmpeg directly; the
[echo-media README](../echo-media/README.md#wiring) tracks them.

Some processing runs outside the main media path:

- **PDF tools.** `pdftotext` and `pdf2htmlEX` are only used by a terminal
  oneoff (`terminal/mod.rs`).
- **OpenCV.** It is behind the optional `opencv` feature.

## Serving

### Messenger media

These routes are in `rer_importer/mod.rs`, `messenger/`, `sigint/media_conversion/`
and `media_summary/`. All of them check `audio_ref::authorized` or
`ensure_media_access`.

| Route | Returns | Headers |
| --- | --- | --- |
| `GET/HEAD /api/messenger/media/{id}` | original bytes, local retained copy or S3 | stored `content_type` |
| `GET /api/messenger/media/{id}/playback` (+ `preview.m3u8`, segments) | MP4 copy, HLS, or redirect to the original | `private`, no shared cache |
| `GET /api/messenger/media/{id}/thumbnail` | JPEG | `private, no-cache` |
| `GET /api/messenger/media/{id}/wave`, `/spectrogram` | PNG | `milgeo-audio-wave` disposition |
| `/api/messenger/media/{id}/kmz-conversion/*` | status JSON, KMZ, ZIP | attachment |
| `/api/messenger/media/{id}/summary*` | JSON | — |
| `GET /api/admin/ocr/{id}/preview` | sanitized OCR HTML | `default-src 'none'; img-src data:` CSP |
| `GET /api/admin/ocr/{id}/media` | original bytes via `serve_messenger_media` | **none of the media document headers** |

For `GET/HEAD /api/messenger/media/{id}`, the headers are:

- **Content type.** The stored `content_type`.
- **Document CSP.** A sandboxed document CSP. Video and audio get a player CSP
  without `sandbox`.
- **Other security headers.** `nosniff`, `Cross-Origin-Resource-Policy:
  same-origin`, `Referrer-Policy: no-referrer` and
  `X-DNS-Prefetch-Control: off`.

They are set in `rer_importer/mod.rs` `apply_media_document_security_headers`.

### Device files

`R = /api/device/files/{device_id}/{file_id}/revisions/{revision}`; details in
[devices-file-preview.md](devices-file-preview.md).

| Route | Returns | Headers |
| --- | --- | --- |
| `GET/HEAD R/content` | original | `attachment`, `application/octet-stream`, `nosniff`, `private, no-store` |
| `GET/HEAD R/preview/media` | audio, video, PDF | `inline`, canonical MIME (audio/video subtype from the stored MIME), `nosniff`, single byte range |
| `R/archive`, `R/preview/geodata/...` | ZIP tree state, KMZ | JSON / KMZ |
| Device audio `.../content` | MP3 rendition, PNG wave | generated by Echo |

### Download names

`utils/multipart.rs` `download_content_disposition` picks `inline` or
`attachment` from the file-name extension.

- **Inline** covers image, text, audio, video, JS, JSON, XHTML and WASM.
- **Attachment** is used for everything else.
- **Sanitising.** CR, LF, VT and FF in the fallback name are percent-encoded.

## Browser viewers

The viewer code is under `wdintel-web/src/ts/react/routes/shared/message-card/`
(`renderers/`, `docx/`, `xlsx/`, `legacy-office/`, `kmz/`, `csv/`).

| Format | Viewer | Isolation |
| --- | --- | --- |
| JPEG, PNG, GIF, WebP, BMP, SVG | `<img>` (thumbnail first, then original) | an `<img>` never runs SVG scripts; opening an SVG directly hits the sandbox CSP |
| Video | `<video>`, `hls.js` (lazy) | player CSP on the original route |
| Audio | `<audio>`, server waveform/spectrogram | — |
| PDF | `react-pdf` / `pdfjs-dist` 5.x, range requests with credentials, 24-page limit | PDF.js worker (`.mjs`) |
| DOCX | `docx-preview`, `mammoth` in a worker, DOMPurify allowlist | `<iframe sandbox="" srcDoc>` |
| XLSX | `read-excel-file` in a worker | worker |
| DOC, XLS | vendored, patched SheetJS CE 0.20.3 and JSDoc `docToText` ([VENDOR_MANIFEST.md](../wdintel-web/src/ts/react/routes/shared/message-card/legacy-office/VENDOR_MANIFEST.md)) | worker, nginx CSP on the worker scripts |
| CSV, TXT, MD | worker; `react-markdown` + `remark-gfm` with `skipHtml` and `<img>` disallowed (`text-document-preview.tsx`) | — |
| KML, KMZ | `fflate`, `@xmldom/xmldom`, `@tmcw/togeojson`, Leaflet | worker |
| ZIP | `fflate` worker (messages); server tree (Devices) | worker |

Uploads from the browser use `@uppy/*` and `tus-js-client`.

The SPA itself is served by nginx without a page-level Content-Security-Policy.
The only `add_header Content-Security-Policy` in `deploy/nginx/*` is on the
`doc-preview` and `xls-preview` worker scripts.

## Software components

### System binaries and services

| Component | Used for | Runs as |
| --- | --- | --- |
| FFmpeg / ffprobe (distro package, found on `PATH`) | thumbnails, playback copies, HLS preview, waveforms, device audio, transcription probe | `root`, inside `wdintel-rs` / `wdintel-rs-bgworker`; thumbnails run sandboxed through `echo-media` (no capabilities, Landlock) |
| libx264, libmp3lame, AAC encoder | HLS preview, device audio rendition | same |
| signal-cli-rest-api / signal-cli | Signal ingest and attachment download | `root` (`echo-signal-bot@`) |
| whatsapp-cli | WhatsApp ingest | `root` (`echo-whatsapp-bot@`) |
| echo-document-extractor (Python 3.13: FastAPI, PaddleOCR 3.7, paddlepaddle 3.3, pypdfium2, Pillow, lxml, openpyxl, python-docx, python-pptx, libarchive-c) | OCR, document and archive extraction | separate host/container `ct-echo-document-extractor` |
| LibreOffice, bubblewrap, libseccomp | DOC/RTF/ODT/XLS/ODS/PPT/ODP conversion inside the extractor | extractor sandbox |
| Alpine conversion service | geodata → KMZ | external HTTP service |
| echo-gpu / GPU queue | transcription | GPU host |
| S3-compatible storage (Backblaze B2) | originals, device content | — |
| nginx | TLS, upload size limits (`client_max_body_size`), static SPA | — |
| poppler `pdftotext`, `pdf2htmlEX` | terminal oneoff only | — |

All `debian/*.service` units run as `User=root` with no systemd sandboxing
options.

### Rust crates (wdintel-rs)

| Crate | Use |
| --- | --- |
| `infer`, `mime_guess` | content sniffing, extension → MIME |
| `image` 0.25 (jpeg, png, webp) | AI-agent upload images |
| `strong-box` 0.5 | object encryption |
| `opendal` 0.54, `reqsign` | S3 access, pre-signed URLs |
| `zip` 4.6, `flate2` | ZIP archives, KMZ, OCR packages |
| `quick-xml`, `tl`, `nipper` | KML/XML/HTML parsing |
| `ammonia` | OCR and extracted HTML sanitising |
| `calamine`, `docx-rs`, `rust_xlsxwriter`, `csv` | spreadsheet and report import/export |
| `geoconvert`, `milgeo-rs` | coordinates, map formats |
| `milgeo-audio-wave` | waveform/spectrogram (spawns `ffmpeg`) |
| `echo-media` (workspace crate; `landlock` on Linux) | sandboxed ffmpeg/ffprobe jobs; used for thumbnails |
| `actix-web`, `actix-files`, `actix-multipart` | HTTP serving and uploads |
| `content_disposition` | header encoding |
| `opencv` (optional feature) | image processing in `terminal` |

### Frontend packages (wdintel-web)

`pdfjs-dist` 5.4, `react-pdf` 10, `hls.js` 1.7, `docx-preview` 0.4, `mammoth`
1.11, `read-excel-file` 9, vendored SheetJS CE 0.20.3 and JSDoc, `dompurify` 3,
`fflate` 0.8.3, `@xmldom/xmldom` 0.9.12, `@tmcw/togeojson` 5, `leaflet` 1.9,
`react-markdown` 9, `remark-gfm` 4, `@uppy/*` 4, and
`tus-js-client` 4.
