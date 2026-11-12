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
The command processes each server's destination independently. Where servers
use the same bucket, their `doc-media/` objects are shared and later targets
skip the copies already uploaded. No server-name prefix or new configuration
property is introduced. Forced publication still visits every configured server.

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

Install `s5cmd`, `tq`, Python 3.9+, and an SSH client on the publishing machine.
The recipe uses the `active_servers` inventory from `justfile`. It reads each
server's existing `/etc/echo/config.toml` over SSH, extracts only its S3 section
in memory, and passes credentials through the upload process environment.
It does not install tools or write files on the servers.

After obtaining approval naming the target inventory and B2 destinations:

```bash
just release-doc-media
just release-doc-media --only docs/releases/2026-10-29/media
just release-doc-media --force --only docs/releases/2026-10-29/media
```

Each invocation processes the selected media set once for every unique server.
Default source roots are `docs/releases` and `docs/static`. The recipe explicitly
allows MP4, WebM, JPEG/JPG, PNG, MP3, GIF, SVG, and ICO files; text and other assets
are excluded. `--only` replaces the default roots and must name a directory
inside the checkout. Filenames and directory structure, including Unicode and
spaces, are preserved. Resolve Git LFS pointers before publishing.

Existing keys are skipped separately at each destination, even if the local
file has changed. `--force` replaces every selected object on every destination;
no objects are deleted. Configurations are checked before uploads begin. A
failed destination does not prevent the remaining destinations from being
attempted; the command reports per-server counts and exits nonzero if any fail.
Preserve the report and retry incomplete targets within the approved scope.
Re-running the default command skips successful copies.

For a reviewed subset, supply the existing just variable explicitly, for example
`just active_servers='echo-pivnich' release-doc-media`. New servers need their
own initial publication before relying on fallback delivery.

Private local configuration copies can be supplied with
`DOC_MEDIA_CONFIG_DIR=/private/path`; files must be named `<server>.toml`.
This avoids SSH and supports isolated validation. Never commit these files.

## Editing locally

Release media under `docs/releases/*/media/` and documentation media under
`docs/static/` are stored in B2 and ignored by Git. The docs favicon
`docs/static/icon.png`, styles, and theme assets remain tracked. Existing local
media files are kept when removing them from Git's index.

Use the same tools and configuration as publishing to restore media from one
server's existing B2 destination into its original checkout paths:

```bash
just download-doc-media --server echo-pivnich
just download-doc-media --server echo-pivnich --only docs/releases/2026-10-29/media
just download-doc-media --server echo-pivnich --only docs/static --force
```

Downloads read B2 and write only to the local checkout. The default restores
both source roots and skips existing files, preserving local edits. `--only`
selects a directory within either source root, even if it does not exist yet.
`--force` replaces selected local files; failed transfers leave existing files
intact. No local or remote files are deleted. Unsafe object paths and local
symlinks are rejected.

Edit the downloaded files in place. After obtaining approval for the target
servers and B2 destinations, upload replacements with the existing recipe:

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

1. Publish and verify the selected media separately for every target server.
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
local configurations and a filesystem-backed transfer-command substitute,
including local-edit preservation, failed downloads, and unsafe paths. Backend
#3938 regressions cover cache fills, B2-only delivery/ranges, authorization, and
unsafe paths. No validation command requires a real B2 upload.
