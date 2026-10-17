# Quick intelligence-report suggestions

The quick path prepares a draft while an operator opens a new intelligence
report. It is available to RER and Cyber users, is disabled by default, and
makes an OpenAI-compatible structured-output request to the primary engine.
If the primary attempt fails, a configured fallback engine gets one retry
with the same prompt and its own token budget and attempt timeout, bounded by
the remaining overall time. A successful primary response skips fallback;
without a configured fallback, the primary error is returned. Any fallback
failure ends generation without a third attempt. The [government transport](ai/government-inference.md)
may renew authorization and retry an initial HTTP 401 once. The selected system prompt is compiled from
`ai-eval/2026-08-19-intelligence-report-prompt/prompt.txt`.

## Access and data flow

The endpoint reuses the direct-copy message-access predicate. It accepts only
an accessible, nondeleted source or linked intelligence-report message.
Current facts consist of the message body plus audio
transcriptions and document summaries that were already completed; this path
does not enqueue, await, or download attachment processing.

Style examples come from explicit `intel_product` report links and human
`sigint_comment` rows. They must precede the target, fall within three days,
belong to an accessible source, contain a nonempty report of at most 160
characters, and contain no digits. Sources have headers removed, numeric tokens
redacted, and text truncated before prompting. Exact normalized-source matches
come first; within each match class, examples are ordered by the current
operator, then the same organism, then other accessible operators. At most
twelve candidates are read per priority bucket, two are retained per bucket,
and six are sent globally. An exact match marks the highest-priority historical
product as the strongest prompt example without forcing it into the generated
variants.

The request is capped at 12,000 current-source characters, 1,500 characters
per example source and 24,000 total prompt characters. Output defaults to 512
tokens per engine, including reasoning tokens. The primary attempt, fallback
attempt, and overall generation each default to twenty seconds. The overall
deadline includes preparation and both attempts; starting a fallback does not
reset it. Administrators can set each engine's budget to 1–32,768 tokens and
each timeout to 1–180 seconds. The response must be
strict JSON containing one to three distinct nonempty paragraphs totaling at
most 1,000 characters; new numeric or coordinate tokens are rejected as content
validation failures. Multiple variants are displayed in a small carousel and are
inserted only when the operator clicks the selected text.

GPT-5, GPT-6, and o-series engines use `max_completion_tokens` and omit
`temperature`. Quick suggestions disable reasoning only for explicitly
supported aliases and their dated snapshots; other engines retain their
provider's reasoning default. Ordinary chat requests keep their existing
reasoning behavior. See the [OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning?api-mode=chat)
for model-specific effort support.

Source material, style examples, and prompts are never written to the database
or application logs. Each authorized attempt stores its bounded outcome,
duration, validated suggestions, bounded raw model response, and safe error
chain for administrator review. Telemetry records a bounded outcome and
request duration.

## Administration

Administrators configure the feature at `/admin/ai/intelligence-reports`.
Only enabled engines with the `callsign_enabled` capability are selectable.
The page lists every configured model with its editable token budget and
primary/fallback radio buttons. The primary and optional fallback must differ;
budgets stay attached to their engines when selections change. Per-attempt
and overall timeouts are configured independently. Existing installations
retain their primary engine, have no fallback, and use 512 tokens per engine
and twenty-second timeouts until configured. Increasing a token budget does
not increase the 1,000-character limit for validated suggestions.
An engine cannot lose that capability or be deleted while an enabled quick
report setting uses it. The same screen lists the latest attempts and exposes
their validated suggestions, raw model responses, and failure diagnostics
without source messages or prompts. Each logical request records the last
engine attempted and its bounded response; duration includes preparation and
both model calls. Primary failures, including token exhaustion
(`finish_reason=length`, even with empty content), HTTP or connection errors,
per-attempt timeouts, malformed output, and unsupported facts, invoke the
configured fallback once if time remains before the overall deadline. An
expired overall deadline ends generation without another model call.

Attempt history loads twenty entries per page, discovering the next cursor
with one lookahead row. Numbered navigation covers discovered pages, and
“SHOW MORE” appends the next page. A total count appears only when the initial
page contains the entire history. Refresh returns to the newest page. New
attempts do not shift established page boundaries. Table search, filters, and
sorting apply to loaded entries.

## Deployment

Migrations leave quick suggestions disabled. After applying migrations, first
inspect and then migrate legacy comments before switching all readers to linked
comment messages:

```bash
sudo /usr/bin/wdintel-rs --mode=live oneoff-migrate-sigint-comments --batch-size=1000 --dry-run
sudo /usr/bin/wdintel-rs --mode=live oneoff-migrate-sigint-comments --batch-size=1000
```

On installations with ClickHouse, perform a full PeerDB mirror resync so
`signal_message_media`, `intel_product`, and `sigint_comment` are reconciled, then
verify the snapshot tables and analytics health before continuing deployment:

```bash
sudo /opt/echo-peerdb/bin/resync.sh --yes
sudo /opt/echo-peerdb/bin/finish-resync.sh
```

See the [PeerDB day-two runbook](../deploy/clickhouse/README.md#day-two-operations)
for status and health commands.

For staging rollout, select engine
`019fc79a-d3dc-79a2-8523-a55612920ec4` on `echo-staging` and
`019fa4a6-5a92-7692-a8d1-4f5e701d568c` on `echo-cbr-staging`. Enable quick
suggestions only after authorization, inaccessible-group, safety, and timeout
tests pass and warm p95 is below five seconds. Keep production disabled until
the separate CBR/Cyber and Pivnich/RER evaluations are reviewed. Server-specific
engine IDs are operational configuration and are not stored in migrations.

Evaluation exports and reproducible tools are documented in
`ai-eval/2026-08-19-intelligence-report-prompt/README.md`. Production-derived
text and human reviews remain under the gitignored `raw/` directory and the
private B2 evaluation prefix.
