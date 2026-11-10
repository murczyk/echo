# Media security audit checklist

This checklist covers how Echo accepts, processes and serves media. It maps
each check to OWASP and MITRE references. The pipeline it audits is described in
[media-processing.md](media-processing.md).

The scope is messenger attachments (Signal, WhatsApp, ingest collectors) and
Device files (FileSync, audio). It also covers the derived-media workers, the
HTTP routes that serve media, and the browser viewers.

**References**

- OWASP Top 10:2021 (`A01`–`A10`).
- OWASP ASVS 4.0.3 (`V…`), mainly V12 (Files and Resources), V5 (Validation)
  and V14 (Configuration).
- The OWASP File Upload Cheat Sheet.
- MITRE CWE identifiers.
- MITRE ATT&CK Enterprise techniques, in the [last section](#mitre-attck-mapping).

**Status**

- `GAP`: the code shows the control is missing or weaker than expected.
- `VERIFY`: the control may exist; confirm it by test or review.
- `OK`: a control exists. The auditor should still try to break it.

Code references use `wdintel-rs/src/` unless they say otherwise.
`echo-media/` is the sandboxed ffmpeg crate
([README](../echo-media/README.md)).

## Known gaps (start here)

These came from reading the code while preparing this checklist. None have been
tested on a live system. G1, I2 and I3 are partly fixed: thumbnails now run
through `echo-media`. No other gap has been worked on.

| # | Gap | Where | CWE | Severity guess |
| --- | --- | --- | --- | --- |
| G1 | ffmpeg/ffprobe run on attacker files **without `-protocol_whitelist` / `-format_whitelist`**. The HLS and concat demuxers can read local files (sending them to a remote listener) or make network requests (SSRF). Partly fixed: messenger and Device thumbnails go through `echo-media`, which whitelists every input. `echo-media/tests/hostile.rs` reproduces the leak with plain ffmpeg and shows both the whitelists and the sandbox block it. | Remaining: `transcription/worker.rs` audio probe; `milgeo-audio-wave` `src/ffmpeg.rs` (waveform/spectrogram) | 918, 73, 200 | High |
| G2 | Every service unit runs as **`root`** with no systemd hardening: no `NoNewPrivileges`, `ProtectSystem`, `PrivateTmp`, `ProtectHome`, `CapabilityBoundingSet`, `SystemCallFilter`, `MemoryMax` per child, or network restrictions. One decoder RCE gives an attacker root on the host, plus S3 credentials and the StrongBox key. | `wdintel-rs/debian/*.service` | 250, 269 | High |
| G3 | The stored `content_type` is **taken from the sender or collector**. Any declared `image/*`, `audio/*` or `video/*` type, or any non-generic type, wins over the sniffed type. The original is served with that type. | `messenger/media.rs` `resolve_attachment_content_type` | 434, 646, 345 | Medium (mitigated by G4's CSP on the main route) |
| G4 | `GET /api/admin/ocr/{id}/media` serves originals through `serve_messenger_media` **without** the CSP sandbox, `nosniff`, CORP or Referrer-Policy that `/api/messenger/media/{id}` sets. | `ocr/mod.rs` media route; `rer_importer/mod.rs` `apply_media_document_security_headers` | 79, 80, 116 | Medium |
| G5 | The SPA has **no page-level CSP**. nginx adds CSP only to the `doc-preview` and `xls-preview` worker scripts. Any HTML injection from file names, OCR text or document previews would run with the analyst's session. | `deploy/nginx/*` | 79, 1021 | Medium |
| G6 | `download_content_disposition` picks `inline` from the file-name extension for image, text, audio, video, JS, JSON, XHTML and WASM. | `utils/multipart.rs` `download_content_disposition` | 79, 434 | Medium (depends on callers) |
| G7 | The HLS preview passes a **pre-signed S3 URL as an ffmpeg argument**. Any local user or process listing can read it from `/proc/<pid>/cmdline` for up to 10 min. | `messenger/media_preview/source.rs` `input` | 214, 522 | Low |
| G8 | Waveform/spectrogram PNG cache files use **predictable `/tmp` paths** (`/tmp/wave-<id>.png`) and are read back by path, following symlinks. Combined with G2 (root, no `PrivateTmp`), a local user can plant or symlink files. | `messenger/media_wave.rs`; `config.rs` `MESSENGER_MEDIA_AUDIO_PNG_TMP_DIR` | 377, 59 | Low |
| G9 | Signal attachment paths are built as `attachment_path.join(attachment.id)`. An `id` containing `/`, `..` or an absolute path would escape the directory. `O_NOFOLLOW` protects only the last path component. | `echo-im` `signal/sync_inbox.rs` `save_attachment_restapi`; `messenger/media.rs` `prepare_attachment` | 22, 73 | Low (depends on how signal-cli forms ids) |
| G10 | No malware or AV scanning, and no metadata (EXIF/GPS) stripping, on inbound or outbound media. | whole pipeline | 434, 212 | Policy decision |

Open questions carried over from earlier review. They are unverified.

- **Assets route.** `/api/assets/{filename:.*}` may allow path traversal, and
  its S3 fallback may bypass access checks (`storage.rs`, `server/mod.rs`).
- **Logout over GET.** `GET /api/user/logout` might be triggered cross-site, for
  example by an `<img>` in previewed content (`users/mod.rs`).
- **Sandboxed media pages.** Even under the sandbox CSP, opened media documents
  may still contact outside servers through meta refresh, preconnect,
  user-clicked links and PDF viewer actions.

## OWASP checklist

### 1. Upload acceptance and validation

Covers A04 Insecure Design, A05 Security Misconfiguration, and ASVS V12.1,
V12.2 and V5.1.

| ID | Check | Where | Refs | Status |
| --- | --- | --- | --- | --- |
| U1 | Per-file size limits are enforced server-side before buffering. Confirm that the TUS (6 GiB), audio (100 MiB), avatar (20 MiB), OCR source (250 MiB) and nginx `client_max_body_size` limits agree, and that `Upload-Length` is rejected early. | `tus.rs`, `messenger_ingest/`, `devices/audio/`, `deploy/nginx/*` | V12.1.1, CWE-400, 770 | VERIFY |
| U2 | Per-user, per-device and global quotas exist, so a single sender cannot fill S3 or the local disk. | `device_upload_finalization` budgets; messenger ingest | V12.1.3, CWE-770 | VERIFY (messenger ingest has none documented) |
| U3 | The file type comes from the content, not from the name or declared MIME. Each consumer allowlists the types it accepts. | `messenger/media.rs` (G3), `devices/files/content/preview.rs` `media_content_type`, `ocr/worker.rs` `source_mime` | V12.2.1, CWE-434, 646 | GAP (G3) |
| U4 | Polyglots (for example a valid JPEG that is also HTML, PDF or ZIP) cannot reach a context where the second format is interpreted. | content sniffing plus serving headers | V12.2.1, CWE-434 | VERIFY |
| U5 | The sender's file name never becomes a filesystem path or command argument. It is stored only as metadata. | `fallback_file_name`, staging and cache paths (by media id) | V12.3.1, V12.3.5, CWE-22, 78 | OK, verify |
| U6 | File names are length-limited and Unicode-normalised. Check RTL override (U+202E), NUL, control characters, very long names and reserved names. | ingest, FileSync, UI rendering | V5.1.3, CWE-20, 838 | VERIFY |
| U7 | Device audio is fully decoded and its length checked before acceptance. | `devices/audio/probe.rs` | V12.2.1 | OK |
| U8 | Operator image replacement requires the sniffed type, the declared type and the extension to agree (JPEG, PNG or WebP only). | `messenger/media.rs` `validate_replacement_image` | V12.2.1 | OK |

### 2. Parser and decoder hardening

Covers A06 Vulnerable Components, A03 Injection, and ASVS V12.1.2, V12.3.3,
V12.6 and V5.5.

| ID | Check | Where | Refs | Status |
| --- | --- | --- | --- | --- |
| P1 | Every ffmpeg/ffprobe call sets `-protocol_whitelist` (`file,pipe`, or exactly the network protocols it needs) and `-format_whitelist`. Test with HLS (`#EXTM3U`), `concat:`, `ffconcat`, `subfile`, `tee`, `data:` and image2 globbing payloads, using a real-type name such as `.mp4` or `.jpg` and the production `.source` name. | `echo-media` adds both whitelists to every input it runs (thumbnails); `echo-media/tests/hostile.rs` covers HLS (`file://`, path, `http://`, `concat:`, `subfile:`), ffconcat and image2 `%d` names, but not `tee` or `data:`. Remaining: `transcription/worker.rs`, `milgeo-audio-wave`; compare with `media_local_cache/playback.rs` and `devices/audio/*` | V12.3.3, V12.6.1, CWE-918, 73 | GAP (G1; thumbnails OK) |
| P2 | The HLS preview's `mov` demuxer keeps `enable_drefs` off, and `http`/`https` cannot be redirected off the S3 host. | `media_preview/source.rs` `input_options` | CWE-918, 601 | VERIFY |
| P3 | Decompression bombs are bounded: pixel floods (huge-dimension PNG/JPEG/WebP/GIF), long or high-frame-rate video, and audio with an extreme sample rate or channel count. Each needs a time, memory and output-size bound. The thumbnail job has a 120 s timeout and 1 thread, but its memory is bounded only by the service-wide `MemoryMax` (16G for `wdintel-rs`, 28G for `wdintel-rs-bgworker`). `echo-media` deliberately sets no CPU or address-space limit and caps only output size (Device thumbnails 2 MiB). `echo-media/tests/hostile.rs` checks that a 65535×65535 PNG fails fast. | `thumbnail.rs`, `echo-media/`, `media_preview/`, `image` crate users, `ai_agent/uploads/image.rs` | V12.1.2, CWE-400, 409, 789 | VERIFY |
| P4 | Archive extraction defends against zip bombs, nested archives, path traversal (`../`, absolute, `\`), symlink entries, duplicate and case-colliding names, and encrypted entries. | `devices/files/archive/` helper (limits documented); `ocr/package.rs` `safe_archive_name`; frontend `zip-preview.worker.ts`; extractor libarchive | V12.1.2, V12.3.1, CWE-22, 409, 59 | OK (Device ZIP), VERIFY others |
| P5 | `ocr/package.rs` `read_entry` allocates from the declared entry size and reads to the end. Confirm that the zip crate caps real output at the declared size, or add a `take()`. | `ocr/package.rs` | CWE-409, 789 | VERIFY |
| P6 | XML parsers do not expand external or recursive entities (XXE, billion laughs). Check KML/KMZ, DOCX/XLSX/PPTX (lxml, openpyxl, python-docx in the extractor), `quick-xml`, `@xmldom/xmldom` and `togeojson`. | `kml/`, `rer_importer/`, extractor, `kmz/` | V5.5.2, CWE-611, 776 | VERIFY |
| P7 | Office documents: macros are never evaluated, external links and OLE objects are not fetched, and LibreOffice runs in bubblewrap with seccomp and no network. | `echo-document-extractor` | V12.3.6, CWE-829 | OK (documented), VERIFY sandbox profile |
| P8 | PDF.js keeps `isEvalSupported` false, has no XFA scripting, and is ≥ 4.2.67 (CVE-2024-4367). Echo uses 5.4. PDF links and actions cannot navigate the app. | `renderers/PdfDocumentPreview.tsx` | A06, CWE-94 | VERIFY |
| P9 | The vendored, patched SheetJS and JSDoc copies match `VENDOR_MANIFEST.md` hashes, and their hostile-input suites run in CI. | `wdintel-web/.../legacy-office/` | A06, A08, CWE-1104 | VERIFY |
| P10 | Native decoders (FFmpeg, libx264, poppler, pdfium, Pillow, Paddle, LibreOffice, libarchive) are on patched versions and tracked for CVEs. FFmpeg comes from the distro package on hosts; record the version on each host. | hosts, extractor `uv.lock` | V14.2.1, A06, CWE-1395 | VERIFY |
| P11 | Fuzz or corpus-test each parser entry point with known-bad samples. See [Test corpus](#test-corpus). | — | V14.2 | VERIFY |

### 3. Storage and file system

Covers A01, A04 and A05, and ASVS V12.4, V1.12 and V6.

| ID | Check | Where | Refs | Status |
| --- | --- | --- | --- | --- |
| S1 | Originals live outside any web root. Local caches are `0700` dirs with `0600` files, and are published atomically. | `messenger_media_cache/*`, `device-file-archive` | V12.4.1, CWE-276, 732 | OK, verify on hosts |
| S2 | Temp files are created with `O_EXCL` and a random name in a private directory, never at a predictable `/tmp` path. | `media_wave.rs` (G8), `MESSENGER_MEDIA_AUDIO_PNG_TMP_DIR`, `tempfile` users | CWE-377, 379, 59 | GAP (G8) |
| S3 | Ingest reads attachment sources with `O_NOFOLLOW`, as regular files only, from an expected directory. Confirm that the source directory is not writable by other users. | `messenger/media.rs` `prepare_attachment`; `/etc/echo/*-cli-data` perms | CWE-59, 367, 22 | VERIFY (G9) |
| S4 | Encryption at rest: originals > 100 MiB and the excluded video types are **plaintext** in S3. Confirm that this is accepted policy and that the bucket is private with no public ACLs or listing. | `should_encrypt_media`, `MESSENGER_MEDIA_ENCRYPTION_EXCLUDED_*` | V6.1.1, V8.1, CWE-311 | VERIFY |
| S5 | StrongBox key management: storage and rotation of `s3_config.strongbox_key`, who can read `config.toml`, and backups. | config, `storage.rs` | V6.4, CWE-320, 522 | VERIFY |
| S6 | Pre-signed URLs are short-lived, stay server-side, and do not appear in argv, logs or responses. | `media_preview/source.rs` (G7) | V8.3, CWE-214, 532 | GAP (G7) |
| S7 | Deleting a message removes its S3 object, retained copies, thumbnails, preview segments and PNG caches. | `delete_stored_media_files`, `delete_local_media_files` | V8.3.8, CWE-459 | VERIFY (PNG `/tmp` cache likely not removed) |
| S8 | Cache keys use the media id, and an authorisation check runs before every cache hit (thumbnail, PNG, preview segments, retained original). | `media_thumbnail.rs`, `media_wave.rs`, `media_preview/` | V4.1.3, CWE-524, 639 | VERIFY |

### 4. Serving and the browser

Covers A03 (XSS), A05, and ASVS V12.5, V14.4, V5.3 and V13.

| ID | Check | Where | Refs | Status |
| --- | --- | --- | --- | --- |
| B1 | Every route that returns attacker bytes sets `nosniff`, a restrictive document CSP (`sandbox` for non-player types), `Cross-Origin-Resource-Policy: same-origin` and `Referrer-Policy: no-referrer`. Enumerate the routes: `/api/messenger/media/{id}`, `/api/admin/ocr/{id}/media`, `/api/device/files/.../preview/media`, `/api/device/files/.../content`, AI-agent upload originals and documents, kmz-conversion downloads, and `/api/assets/*`. | `rer_importer/mod.rs`, `ocr/mod.rs`, `devices/files/content/`, `ai_agent/uploads/api.rs`, `ai_agent/documents/api.rs` | V12.5.2, V14.4.3, V14.4.4, CWE-79, 116 | GAP (G4), VERIFY rest |
| B2 | Open SVG, HTML, XHTML, XML, PDF, and a polyglot attachment directly in a new tab. No script runs, no request leaves the origin, and a video or audio file still plays. | all inline routes | V12.5.2, CWE-79, 80 | VERIFY |
| B3 | `Content-Disposition`: the sender's file name cannot break the header (CR/LF, quotes, `;`), and the inline/attachment choice does not depend on an attacker-chosen extension. | `utils/multipart.rs` (G6), `content_disposition` crate | V12.3.4, CWE-113, 79 | GAP (G6) |
| B4 | The SPA has a CSP (`script-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'self'`), plus HSTS, `X-Frame-Options` or `frame-ancestors`, and Referrer-Policy. | nginx (G5) | V14.4.3, V14.4.5–7, CWE-1021 | GAP (G5) |
| B5 | File names, captions, OCR text, extracted text and summaries are output-encoded wherever they are rendered. Check message cards, search snippets, map popups (Leaflet `bindPopup` with HTML), toasts and `title` attributes. | `wdintel-web` message-card, KMZ map, search | V5.3.3, CWE-79 | VERIFY |
| B6 | Rich previews are isolated. DOCX uses DOMPurify plus `<iframe sandbox="" srcDoc>`. Markdown uses `skipHtml` with `<img>` disallowed. OCR HTML uses `ammonia` and is served with CSP. Check for `href` with `javascript:`/`data:` and CSS-based leaks. | `docx/sanitize-docx-html.ts`, `DocxDocumentPreview.tsx`, `text-document-preview.tsx`, `ocr/package.rs` | V5.3.3, CWE-79 | OK, verify bypasses |
| B7 | Tracking and beacons: opening or previewing media must not contact servers the sender chose (remote images in DOCX, PDF URI actions, KML `<Icon href>`, HLS URLs, DNS prefetch). Contact would reveal the analyst's IP or the time the file was opened. | viewers, `X-DNS-Prefetch-Control`, image `src` filtering | V12.6.1, CWE-200, 359 | VERIFY |
| B8 | Workers parse untrusted formats off the main thread, are cancelled on close, and enforce limits on time, rows, cells and pages. | `workers/worker-client.ts`, `document-grid-limits.ts`, legacy-office limits | CWE-400 | OK, verify |
| B9 | Clipboard copy of images (`copy-image-to-clipboard.ts`) re-encodes the image rather than copying the original bytes. | frontend | CWE-212 | VERIFY |

### 5. Access control

Covers A01 Broken Access Control and ASVS V4.

| ID | Check | Where | Refs | Status |
| --- | --- | --- | --- | --- |
| A1 | IDOR: every media route resolves the media id and then checks group, message, device and organism access on **each** request, including HEAD, Range, playlist, segments, thumbnails, wave, spectrogram, summaries and conversions. | `messenger/audio_ref.rs` `authorized`, `messenger/media.rs` `ensure_media_access`, device `authorize_read` | V4.2.1, CWE-639, 862 | VERIFY with a second user |
| A2 | Deleted, archived and revoked messages and devices stop serving bytes immediately, including from local caches. | serving routes, caches | V4.1.3, CWE-613 | VERIFY |
| A3 | Admin OCR routes require the admin role and do not widen media access. | `ocr/mod.rs` | V4.1.1, CWE-285 | VERIFY |
| A4 | Ingest tokens and collector accounts can only attach to their own datasource, chats and messages, and only with their own completed TUS uploads. | `messenger_ingest/attachments.rs` | V4.2.1, CWE-639 | OK (documented), verify |
| A5 | CSRF: state-changing routes are not GET (for example logout), and the session cookie is `SameSite=Lax` or stricter. Previewed content that can make same-origin GETs (`img-src 'self'`) must not trigger an action. | `users/mod.rs`, session middleware | V4.2.2, V3.4.3, CWE-352 | VERIFY |
| A6 | Webhook delivery from echo-messengers carries only scoped attachment URLs, never bytes, and those URLs require authentication. | `echo-messengers` | V4.1.3 | OK (documented), verify |

### 6. Process isolation and privilege

Covers A05 and A04, and ASVS V1.14 and V14.1.

| ID | Check | Where | Refs | Status |
| --- | --- | --- | --- | --- |
| I1 | Media workers run as a dedicated unprivileged user, with no write access to binaries or config and no read access to keys they do not need. | `debian/*.service` (G2) | V14.1.x, CWE-250, 269 | GAP (G2) |
| I2 | Child decoders run with systemd or bubblewrap sandboxing, per-process memory, CPU and time limits, no network unless required (only the HLS preview needs S3), and a scrubbed environment so S3 and DB secrets are not inherited. | Thumbnails: `echo-media` gives each child a cleared environment, no capabilities, `NO_NEW_PRIVS`, Landlock (read system libraries and the input, write one job directory, execute only ffmpeg), a network namespace when root, a wall-clock timeout and an output-size `RLIMIT_FSIZE`. There are no per-process memory or CPU limits and no seccomp. Remaining: other `Command::new` call sites | CWE-250, 526, 400 | GAP (thumbnails partly OK) |
| I3 | `Command::new("ffmpeg")` resolves through `PATH`. Pin absolute binary paths, or ensure `PATH` is trusted for root units. | `echo-media` `MediaConfig::from_path` resolves `ffmpeg`/`ffprobe` once to canonical absolute paths and skips relative `PATH` entries (thumbnails). Remaining: `config.rs` `MESSENGER_MEDIA_LOCAL_CACHE_FF*_BIN`, `devices/audio/*`, `transcription/worker.rs` | CWE-426, 427 | VERIFY (unit `PATH` must be trusted) |
| I4 | Signal and WhatsApp bots run as root with attachment directories under `/etc/echo`. Review their isolation from `wdintel-rs`. | `debian/echo-signal-bot@.service`, `echo-whatsapp-bot@.service` | CWE-250 | GAP |
| I5 | The extractor host has an outbound network allowlist (routers only) and inbound bearer authentication, and its spool is private. | `echo-document-extractor` | V12.6.1, CWE-918 | VERIFY |

### 7. Logging, monitoring and integrity

Covers A08 Integrity, A09 Logging, and ASVS V7, V10 and V14.2.

| ID | Check | Where | Refs | Status |
| --- | --- | --- | --- | --- |
| L1 | File names and decoder stderr written to logs are escaped (log injection) and contain no secrets or signed URLs. | worker logs, `vector` → SigNoz; `echo-media` `process::sanitize` replaces control characters in decoder stderr and redacts remote URLs and their query strings | V7.1.1, V7.3.1, CWE-117, 532 | VERIFY |
| L2 | Alerts fire on decoder crashes, timeouts and repeated failures per sender. A spike may be an exploit attempt. | thumbnail, preview, OCR and transcription logs | V7.2.2, A09 | VERIFY |
| L3 | Media access is audit-logged per user (who opened which attachment). | serving routes | V7.1.3 | VERIFY |
| L4 | Dependencies are pinned and checked: `Cargo.lock`, `package-lock.json` and extractor `uv.lock` pass `cargo audit`, `npm audit` and `pip-audit`. Git dependencies (`echo-im`, `milgeo-rs`, `echo-gpu`) are pinned by rev. | repo, CI | V14.2.1, V14.2.4, A06, A08, CWE-1104 | VERIFY |
| L5 | Exports: attachment names and extracted text written to XLSX or CSV are escaped against formula injection (`=`, `+`, `-`, `@`). | `rust_xlsxwriter`, `csv` exporters, OCR export | CWE-1236 | VERIFY |

## MITRE ATT&CK mapping

These are the techniques an adversary would most likely use against the media
pipeline. Each row says what to audit and what to watch for.

| Technique | How it applies to Echo | Audit or detect | Checklist |
| --- | --- | --- | --- |
| T1566.001 Phishing: Spearphishing Attachment | Monitored chats deliver adversary-crafted files straight into the pipeline. No user click is needed for thumbnails, OCR or transcription. | Treat every inbound attachment as hostile; parser hardening | P1–P11 |
| T1190 Exploit Public-Facing Application | Server-side decoders (FFmpeg, PaddleOCR, pdfium, LibreOffice, zip) process remote input automatically. | Patch levels, sandboxing, crash alerts | P10, I1–I2, L2 |
| T1203 Exploitation for Client Execution | Analyst browsers parse PDFs, Office files, images and video (PDF.js, SheetJS, docx-preview, hls.js). | Viewer isolation, CSP, patched libraries | B1–B8, P8–P9 |
| T1204.002 User Execution: Malicious File | An analyst downloads and opens an original in a desktop application. | `attachment` disposition, UI warnings, endpoint AV | B3, G10 |
| T1036.008 Masquerading: Masquerade File Type | Declared MIME or extension differs from content; polyglots. | Sniff-based typing, consistent serving | U3–U4, G3 |
| T1027.006 Obfuscated Files: HTML Smuggling | HTML or SVG attachment opened inline builds a payload in the browser. | Sandbox CSP, `nosniff` | B1–B2 |
| T1005 Data from Local System and T1083 File and Directory Discovery | An ffmpeg HLS or concat playlist reads local files such as `/etc/echo/config.toml` or the StrongBox key into a thumbnail or out over the network. | Protocol and format whitelists | P1, G1 |
| T1552.001 Unsecured Credentials: Credentials in Files and T1552.005 Cloud Instance Metadata API | File reads or SSRF from decoders reach config secrets or metadata endpoints. | Whitelists, egress filtering, non-root | P1–P2, I2, S5 |
| T1046 Network Service Discovery | SSRF through decoders or document fetchers probes internal services (Redis, Postgres, the extractor, routers). | Egress allowlist per process | P1, I5 |
| T1567 Exfiltration Over Web Service and T1071.001 Web Protocols | Decoders or viewers send data or open-tracking beacons to adversary hosts. | Egress filtering, CSP `connect-src`/`img-src`, DNS-prefetch off | B7, I2 |
| T1592 Gather Victim Host Information | Tracking pixels and links in documents reveal analyst IPs, user agents and when files were opened. | Block remote content in viewers | B7 |
| T1068 Exploitation for Privilege Escalation | A decoder exploit gets root directly, because services run as root. | Unprivileged users, sandboxing | I1, G2 |
| T1574.007 Hijack Execution Flow: Path Interception by PATH | Unqualified `ffmpeg` and `ffprobe` resolved through `PATH`. | Absolute paths, trusted environment | I3 |
| T1499.003 / T1499.004 Endpoint DoS: Application Exhaustion, Application or System Exploitation | Bombs (pixel, zip, nested, long video) and many large uploads exhaust CPU, RAM, disk or worker slots. | Limits, quotas, timeouts, budgets | U1–U2, P3–P5 |
| T1530 Data from Cloud Storage | Bucket misconfiguration, leaked pre-signed URLs, plaintext large objects. | Bucket policy, URL hygiene, encryption scope | S4–S6, G7 |
| T1195.001 / T1195.002 Supply Chain Compromise | Compromised npm, crate or PyPI packages, vendored parsers, or distro FFmpeg. | Lockfiles, audits, vendor hashes, pinned git revs | L4, P9–P10 |
| T1505.003 Server Software Component: Web Shell | An uploaded file served from a path where it would execute. | Files are never executed; `/api/assets` path handling | U5, B1, open question 1 |

## Test corpus

Build a private corpus, never committed with live payloads that point at real
hosts. Run each sample through every ingest path: Signal, collector TUS, Device
FileSync, device audio, and operator replacement. Check every consumer and every
inline route for each sample.

- **FFmpeg.**
  - HLS playlists using `file://`, `http://` and `concat:`.
  - `ffconcat` lists and `subfile:` inputs.
  - MOV files with external `dref` atoms.
  - Image2 sequences.
  - Use each with `.mp4`, `.jpg`, `.ts` and no extension.
- **Images.**
  - Pixel floods: 65535×65535 PNG, and JPEG/WebP with huge declared dimensions.
  - Animated GIF/WebP with thousands of frames.
  - SVG with `<script>`, `onload`, `<foreignObject>` and external `href`.
  - JPEG/HTML and PNG/ZIP polyglots.
  - EXIF carrying GPS coordinates and very large metadata blocks.
- **Archives.**
  - Zip bombs: flat and nested, plus an overlapping-entry bomb.
  - Entries with `../`, absolute paths, `\`, symlinks, a duplicate or
    case-colliding name, or a 1,024-byte name.
  - Encrypted ZIP; RAR and 7z.
- **Office and XML.**
  - DOCX/XLSX/PPTX with XXE, billion laughs, external images, OLE, DDE, macros
    and external workbook links.
  - KML with external `Icon href` and huge coordinate lists.
- **PDF.**
  - JavaScript actions, URI and launch actions.
  - A font-matrix payload (CVE-2024-4367 style).
  - Huge page count, broken xref, incremental updates.
- **Audio and video.**
  - Extreme sample rates, channel counts and durations.
  - Truncated or corrupt streams.
  - MPEG-TS with a misleading extension.
- **File names.**
  - RTL override, NUL, CR/LF, `"`, `;`, a 4 KiB name, and `<script>`.

Suggested tools: `cargo fuzz` or `afl` for the Rust parsers;
`ffmpeg -protocol_whitelist` regression tests (the FFmpeg payloads above, except
MOV `dref` atoms, run in `echo-media/tests/hostile.rs` against every
`echo-media` job); `cargo audit`, `npm audit` and
`pip-audit` in CI; and a headless browser that opens every
inline route and records network requests.
