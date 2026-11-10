# #3938: documentation media in B2

Stage 1 normalizes media around repository-relative paths. Browsers use
`/doc-media/docs/releases/...` or `/doc-media/docs/static/...`; the backend uses
the corresponding `doc-media/docs/...` key in that server's existing S3
destination. The uploader publishes the same selected media once per unique
server in `active_servers`, reusing its existing configuration and credentials.
No new credentials, namespace configuration, or permission expansion is required.
Servers with the same configured bucket share the `doc-media/` objects; each
server is still processed independently by the uploader.

The authenticated endpoint serves packaged/local files first, downloads misses
atomically, and supports media ranges and `HEAD`. The default-off system setting
`doc_media_serve_from_b2` switches to streaming through Echo with no local-file
access. Media uses plaintext S3 objects independently of attachment encryption.
nginx proxies the endpoint and blocks direct access to its local cache subtree.

Release text/index URLs remain unchanged. The frontend build packages media under
`/usr/share/echo-docs/docs/` and separates release media from public release text.
Zola image/video references use the same authenticated endpoint. Source files
remain in the checkout and Debian package during this stage.

`release-doc-media` skips existing objects independently per destination;
`--force` replaces every selected object for every server; `--only` selects a
repository directory instead of the default media roots. A failed server is
reported without suppressing the others and makes the command exit nonzero.

Stage 2 is deferred until stage 1 is deployed and every remote destination is
complete. It will remove bundled/source media and refresh each local copy on
demand after six hours. Stage 3, permanent B2-only delivery, remains optional.

See [operations and validation](../../docs/doc-media.md) for configuration,
commands, rollout checks, and recovery. All real B2 uploads, deployment, and
environment changes require explicit approval naming their targets.
