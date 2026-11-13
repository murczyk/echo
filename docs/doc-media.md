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
a fixed list of distinct B2 destinations. Each invocation uploads to one selected
bucket, including with `--force`. No server-name prefix is introduced.

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
| `echouastoragecbr` | `echouastoragecbr-lfs backblaze` | `echo-cbr` |
| `echouastorage` | `echouastorage-lfs backblaze` | `echo-kharkiv2`, `echo-kupiansk`, `echo-siversk`, `echo-zp2`, `echo-skhid`, `echo-pivnich` |

Uploads and downloads do not consult `active_servers`, SSH, or server
configuration files. If server storage configurations change, update this
inventory manually.

Both commands require `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in the
environment, following the cloud-access check in [goi/justfile](../goi/justfile).
Before each invocation, export the keys from the selected bucket's Bitwarden
note listed above. The naming convention is `<bucket>-lfs backblaze`. Missing
credentials produce an error naming the matching note before contacting B2.

### Uploading a documentation attachment

1. Put the attachment under `docs/static/`, for example
   `docs/static/tutorial/demo.mp4`. Reference it from a page in `docs/content/`
   with `{{ video(id="tutorial/demo.mp4") }}`. Images use
   `{{ img(id="tutorial/screenshot.png", alt="Description") }}`. For release
   attachments, use `docs/releases/YYYY-MM-DD/media/` and follow the
   [release instructions](CHANGELOG_INSTRUCTIONS.md).

2. Choose a bucket from the table above. For `echouastorage`, open the Bitwarden
   note `echouastorage-lfs backblaze` and export its application key ID and
   application key in the terminal where you will run the command:

   ```bash
   export AWS_ACCESS_KEY_ID='<application-key-id>'
   export AWS_SECRET_ACCESS_KEY='<application-key>'
   ```

3. After obtaining approval naming the target bucket, upload the attachment
   directory:

   ```bash
   just release-doc-media --bucket echouastorage --only docs/static/tutorial
   ```

   `--only` selects a directory and includes its supported media files
   recursively. Omit `--only` to publish media from both default source roots.

4. To replace existing uploads after editing them, add `--force`:

   ```bash
   just release-doc-media --bucket echouastorage --only docs/static/tutorial --force
   ```

   This replaces every selected media file in that bucket. Check the per-bucket
   summary for `failed=0`; existing objects are otherwise skipped.

5. Repeat for `echouastaging` and `echouastoragecbr`, exporting the credentials
   from each bucket's own Bitwarden note before its command. Obtain approval for
   each target. The final reminder lists all three buckets. Commit the Markdown
   references; attachment files remain ignored by Git and are published through
   B2 separately.

Each upload invocation processes the selected media set once for the selected
bucket. Run it separately for all three buckets with their corresponding keys;
the command ends with a reminder listing all three destinations.
Default source roots are `docs/releases` and `docs/static`. The recipe explicitly
allows MP4, WebM, JPEG/JPG, PNG, MP3, GIF, SVG, and ICO files; text and other assets
are excluded. `--only` replaces the default roots and must name a directory
inside the checkout. Filenames and directory structure, including Unicode and
spaces, are preserved. Resolve Git LFS pointers before publishing.

Existing keys are skipped at the selected destination, even if the local file
has changed. `--force` replaces every selected object in that bucket; no objects
are deleted. Credentials are checked before uploads begin. The command reports
counts for that bucket and exits nonzero if any transfer fails. Preserve the
report and retry within the approved scope. Re-running without `--force` skips
successful copies.

A new bucket needs an inventory entry, matching Bitwarden note, and initial
publication before servers can rely on fallback delivery.

## Editing locally

Release media under `docs/releases/*/media/` and documentation media under
`docs/static/` are stored in B2 and ignored by Git. The docs favicon
`docs/static/icon.png`, styles, and theme assets remain tracked. Existing local
media files are kept when removing them from Git's index.

Downloads require `s5cmd`, Python 3.9+, and the same environment credentials as
uploads. Select one of `echouastaging`, `echouastoragecbr`, or `echouastorage` to
restore media into its original checkout paths:

```bash
just download-doc-media --bucket echouastorage
just download-doc-media --bucket echouastorage --only docs/releases/2026-10-29/media
just download-doc-media --bucket echouastorage --only docs/static --force
```

The bucket parameter is required for both uploads and downloads. Omitting it or
passing an unknown bucket prints an error listing the available buckets and
exits before reading credentials or contacting B2.

Downloads read B2 and write only to the local checkout. The default restores
both source roots and skips existing files, preserving local edits. `--only`
selects a directory within either source root, even if it does not exist yet.
`--force` replaces selected local files; failed transfers leave existing files
intact. No local or remote files are deleted. Unsafe object paths and local
symlinks are rejected.

Edit the downloaded files in place. After obtaining approval for the selected B2
destination, upload replacements with the existing recipe:

```bash
just release-doc-media --bucket echouastorage --force --only docs/releases/2026-10-29/media
```

Repeat for the other approved buckets using their corresponding credentials.

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

`python3 deploy/test_doc_media.py` runs the actual just recipe against isolated
environment credentials and a filesystem-backed transfer-command substitute,
including one-bucket uploads and reminders, required bucket selection, Bitwarden
credential hints, local-edit preservation, failed downloads, and unsafe paths.
Backend #3938 regressions cover cache fills, B2-only delivery/ranges,
authorization, and unsafe paths. No validation command requires a real B2 upload.
