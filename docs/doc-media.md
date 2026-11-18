# Documentation media

Release and documentation images, audio, and video use authenticated
`GET`/`HEAD /doc-media/docs/...` requests. Release Markdown and its index remain
at `/releases/`; normal documentation pages remain at `/docs/`.

## Storage and configuration

For `docs/releases/2026-10-29/media/ланцюжки.mp4`, the storage key is
`doc-media/docs/releases/2026-10-29/media/ланцюжки.mp4`. Each server uses its own
existing `[s3_config]`: `s3_bucket`, `s3_endpoint`, `s3_region`,
`s3_access_key_id`, and `s3_secret_access_key`. This follows the attachment
storage destination, replacing the code-defined `message-media/` prefix with
`doc-media/`. The attachment implementation does not add a server-name prefix;
the destination comes from that server's configuration. Do not guess the
destination from its SSH alias or add the server name a second time.

Documentation objects contain plaintext media. They use the existing private
bucket and credentials, and do not use attachment encryption or `strongbox_key`.
Servers using the same bucket share their `doc-media/` objects. Publishing uses
a fixed list of distinct B2 destinations. By default, uploads run sequentially
to staging, storage, then CBR. No server-name prefix is introduced.

The production local root is `/usr/share/echo-docs/`, so the example file is
`/usr/share/echo-docs/docs/releases/2026-10-29/media/ланцюжки.mp4`. The optional
top-level `doc_media_dir` setting overrides the root. Development defaults to
`wdintel-web/.doc-media/`, populated by the frontend build or explicitly:

```bash
python3 deploy/doc_media.py prepare
```

An authorized request first reads the local file. A missing file is downloaded
to a temporary file and atomically published before being served. Downloads are
bounded and concurrent requests for the same file share the cache fill. A
missing remote object returns 404; unavailable storage returns 503. Existing
local files remain available when S3 is unavailable. In stage 1, local files
have no expiry.

The administrator setting “Завантажувати медіа документації безпосередньо з B2”
defaults to off. Save and activate the settings version to enable it. Enabled
requests stream from that server's B2 destination without reading or writing
local files. Byte ranges and `HEAD` support video seeking in either mode.

## Publishing

Install `s5cmd` and Python 3.9+ on the publishing machine. The upload destinations
are fixed in `deploy/doc_media.py` as `UPLOAD_ENDPOINT`, `UPLOAD_REGION`, and
`UPLOAD_BUCKETS`. The current inventory, collected from the server configuration
files, uses `https://s3.eu-central-003.backblazeb2.com` and region `eu-central-003`:

| Bucket | Bitwarden note | Servers |
| --- | --- | --- |
| `echouastaging` | `echouastaging-lfs backblaze` | `echo-staging`, `echo-cbr-staging` |
| `echouastorage` | `echouastorage-lfs backblaze` | `echo-kharkiv2`, `echo-kupiansk`, `echo-siversk`, `echo-zp2`, `echo-skhid`, `echo-pivnich` |
| `echouastoragecbr` | `echouastoragecbr-lfs backblaze` | `echo-cbr` |

Uploads and downloads do not consult `active_servers`, SSH, or server
configuration files. If server storage configurations change, update this
inventory manually.

Both just commands read bucket-specific credentials from the repository-root
`.env`, which is ignored by Git. In a worktree, they first read the main
checkout's `.env`, then apply the worktree's `.env` overrides, like `just notify`.
Fill these values from each bucket's Bitwarden note listed above:

```dotenv
ECHOUASTAGING_DOCS_AWS_ACCESS_KEY_ID=
ECHOUASTAGING_DOCS_AWS_SECRET_ACCESS_KEY=
ECHOUASTORAGE_DOCS_AWS_ACCESS_KEY_ID=
ECHOUASTORAGE_DOCS_AWS_SECRET_ACCESS_KEY=
ECHOUASTORAGECBR_DOCS_AWS_ACCESS_KEY_ID=
ECHOUASTORAGECBR_DOCS_AWS_SECRET_ACCESS_KEY=
```

Empty assignments are placeholders; replace them with real keys. Missing or
blank credentials fail before any storage request, with an error naming the
variables and matching Bitwarden note. Uploads validate every selected bucket
before starting, including all three by default. Downloads require only the
selected bucket's pair. Exported credentials do not replace missing `.env`
values; generic `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` are not used.

### Uploading a documentation attachment

1. Put the attachment under `docs/static/`, for example
   `docs/static/tutorial/demo.mp4`. Reference it from a page in `docs/content/`
   with `{{ video(id="tutorial/demo.mp4") }}`. Images use
   `{{ img(id="tutorial/screenshot.png", alt="Description") }}`. For release
   attachments, use `docs/releases/YYYY-MM-DD/media/` and follow the
   [release instructions](CHANGELOG_INSTRUCTIONS.md).

2. Fill all three bucket credential pairs in `.env` as described above.

3. After obtaining approval naming all three target buckets, upload the
   attachment directory:

   ```bash
   just release-doc-media --only docs/static/tutorial
   ```

   `--only` selects a directory and includes its supported media files
   recursively. Omit `--only` to publish media from both default source roots.

4. To replace existing uploads after editing them, add `--force`:

   ```bash
   just release-doc-media --only docs/static/tutorial --force
   ```

   This replaces every selected media file in all three buckets. Check each
   summary for `failed=0`; existing objects are otherwise skipped.

5. Commit the Markdown references; attachment files remain ignored by Git and
   are published through B2 separately.

Each upload invocation processes the selected media set once per bucket, in
this order: `echouastaging`, `echouastorage`, `echouastoragecbr`. To scope a
retry or another explicitly approved single-bucket upload, pass
`--bucket echouastorage` (or another inventory bucket).
Default source roots are `docs/releases` and `docs/static`. The recipe explicitly
allows MP4, WebM, JPEG/JPG, PNG, MP3, GIF, SVG, and ICO files; text and other assets
are excluded. `--only` replaces the default roots and must name a directory
inside the checkout. Filenames and directory structure, including Unicode and
spaces, are preserved. Resolve Git LFS pointers before publishing.

Existing keys are skipped at each selected destination, even if the local file
has changed. `--force` replaces every selected object in every selected bucket;
no objects are deleted. The command reports counts for each bucket and stops
before the next bucket if any transfer fails. Preserve the report and obtain
approval for recovery actions outside the original scope. Re-running without
`--force` skips successful copies.

A new bucket needs an inventory entry, matching Bitwarden note, and initial
publication before servers can rely on fallback delivery.

### Uploading release media by date

For an explicit user request such as `upload release media for 2026-11-18`,
validate the calendar date and check that `docs/releases/2026-11-18/media/`
exists and contains supported media files, then run:

```bash
just release-doc-media --only docs/releases/2026-11-18/media
```

Replace the date with the requested `YYYY-MM-DD`; do not substitute today's
date or broaden the source directory. This request explicitly approves new
media uploads from that directory to `echouastaging`, `echouastorage`, and
`echouastoragecbr`, in that order, using their `.env` credentials. It does not
authorize `--force`, other directories, or an application deployment. A quoted
example or a request to document this workflow does not authorize an upload.

Check every bucket's summary for `failed=0` and report uploaded/skipped counts.
If credentials are missing, identify the variables without printing values.
If publication fails, stop and report which buckets completed and which remain.
Keep successful uploads; obtain approval for recovery outside the authorized
scope. Requests without an explicit date need clarification before uploading.

## Editing locally

Release media under `docs/releases/*/media/` and documentation media under
`docs/static/` are stored in B2 and ignored by Git. The docs favicon
`docs/static/icon.png`, styles, and theme assets remain tracked. Existing local
media files are kept when removing them from Git's index.

Downloads require `s5cmd`, Python 3.9+, and the same `.env` credentials as
uploads. Select one of `echouastaging`, `echouastoragecbr`, or `echouastorage` to
restore media into its original checkout paths:

```bash
just download-doc-media --bucket echouastorage
just download-doc-media --bucket echouastorage --only docs/releases/2026-10-29/media
just download-doc-media --bucket echouastorage --only docs/static --force
```

The bucket parameter is required for downloads; uploads default to all three
buckets. Passing an unknown bucket, or omitting the download bucket, prints an
error listing the available buckets and exits before contacting B2.

Downloads read B2 and write only to the local checkout. The default restores
both source roots and skips existing files, preserving local edits. `--only`
selects a directory within either source root, even if it does not exist yet.
`--force` replaces selected local files; failed transfers leave existing files
intact. No local or remote files are deleted. Unsafe object paths and local
symlinks are rejected.

Edit the downloaded files in place. After obtaining approval for replacements
in all three B2 destinations, upload them with:

```bash
just release-doc-media --force --only docs/releases/2026-10-29/media
```

Omit `--force` when publishing only new files. Local media remains ignored after
editing; commit the Markdown references and other source changes normally.

## Packaging and rollout

Clean checkouts contain no release or documentation media. Downloads are
optional for building: missing media is fetched from B2 when requested through
the authenticated API. Media present locally is still bundled as normalized
copies in the `wdintel-rs` Debian package under `/usr/share/echo-docs/docs/`.
The frontend build removes release-media copies from its public `/releases/`
output; Zola image/video shortcodes point to the authenticated endpoint. The docs
package retains its HTML, theme assets, and favicon. nginx proxies `/doc-media/`
to Echo and blocks `/docs/docs/` so its filesystem alias cannot expose the media cache.

`just docs` always rebuilds the Zola pages and prepares documentation media,
removing direct image/video copies from `docs/public/`. CI and local package
builds use this recipe so cached HTML cannot retain the old `/docs/` media URLs.
Deploy the rebuilt `echo-docs` package alongside the application; updating
`wdintel-rs` alone does not replace previously installed documentation pages.

After local validation, obtain approval naming the B2 destinations and each
environment operation before running this sequence:

1. Publish and verify the selected media for every configured B2 destination.
2. Install the prepared application/docs packages and the corresponding nginx
   configuration, validate nginx configuration, and activate it using the
   installation's normal deployment procedure.
3. Verify unauthenticated requests fail; authenticated local files, missing-file
   downloads, and video range requests succeed. Test B2-only mode on an approved
   target and return the setting to the intended value.

Every destination must contain the published media before deploying packages
built from a clean checkout. A replacement must be published to every configured
destination using `--force`. Existing server-local copies still have no expiry;
automatic refresh and permanent B2-only delivery are not enabled by removing
media from Git.

If publication is partial, retain successful objects and use the report to
prepare a scoped retry. A B2-only outage can be mitigated by disabling that
setting through the normal save/activate flow, subject to environment approval;
packaged local files remain available. Stage-1 existing local copies do not
refresh after a forced upload; use B2-only mode to inspect a replacement.

## Validation

`python3 deploy/test_doc_media.py` runs the actual just recipes against isolated
`.env` credentials and a filesystem-backed transfer-command substitute,
including sequential uploads, single-bucket selection, credential preflight,
worktree fallback/overrides, partial publication, Bitwarden credential hints,
local-edit preservation, failed downloads, and unsafe paths.
Backend #3938 regressions cover cache fills, B2-only delivery/ranges,
authorization, and unsafe paths. No validation command requires a real B2 upload.
