# Document extractor regressions

This audited live suite covers production documents that exposed extractor
alignment, reconciliation, or fallback defects. Raw production-derived inputs
remain in the Git-ignored `raw/` directory and are synchronized separately to
Backblaze B2 with:

```bash
just ai-eval-sync-from-cloud 2026-08-17-document-extractor-regressions
just ai-eval-sync-to-cloud 2026-08-17-document-extractor-regressions
```

Run the extractor live suite by setting `ECHO_DOC_LIVE_CONFIG`,
`ECHO_DOC_LIVE_LAYOUT_MANIFEST` to `layout-suite-manifest.json`, and
`ECHO_DOC_LIVE_RAW` to this evaluation's `raw/` directory.

The dense numeric report must never finish with failed quality, and the
declared critical anchors must remain searchable. If every model candidate
fails, degraded local OCR is allowed only when the original raster is retained.
