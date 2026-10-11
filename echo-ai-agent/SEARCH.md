# Callsign investigations

The runner uses two independent inbox requests: `search` for message text and
`selectedCallsigns` for extracted tags. Both run even when one already finds
messages. Their results are combined by message ID, with separate pagination.
Combining both fields in one request means AND, which excludes untagged evidence.

Tags are incomplete and can be incorrect. Query arguments are trimmed,
lowercased and deduplicated. The agent evaluates context to distinguish a person
from equipment, acronyms and unrelated names. Ukrainian/Russian alternatives
are inferred from the conversation and evidence; no callsign alias table or
question-template routing is installed.

The loaded instructions are in `runner/search-guidance.ts`, imported into the
system prompt and inbox-tool description. The installed skill file is not the
source of these instructions: Pi skill loading is disabled.

Search follows the existing Echo parser and query builder:

- Ordinary words use Russian stemming. Eligible plain terms also match
  prefixes; OR and negation disable the additional prefix query.
- Unquoted `or` and `-word` support alternatives and exclusions.
- Quotes mean a case-insensitive body substring, not an exact token or
  full-text phrase. `%` is a wildcard; underscore is literal.
- Quoted alternatives require separate requests. Extracted substring filters
  are ANDed, even if the input placed `or` between them.
- Non-frequency dotted terms become literal substring filters. Frequencies
  and lowercase `xxxx-xxxx-xxxx` message UIDs become structured filters.
- `+`, `*`, and parentheses do not add operators or grouping.
- Full-text and literal search cover the parsed message body. Header and
  attachment/OCR coverage must not be assumed.

When indexed text and tags are empty, the agent also checks literal body text,
including relevant inflections or distinctive word stems. These broader matches
still require contextual review. With no explicit user period, searches without identifying evidence, including
equipment, acronym, and other non-person matches, extend from 31 days to the
preceding 31 days and then 28 days: at most 90 Kyiv calendar days, keeping the
existing 31-day request cap. User-specified
periods and group restrictions are preserved. Errors and incomplete pagination
must never be described as proof that no evidence exists.

The [harness evaluations](../ai-eval/HARNESS.md) exercise both retrieval paths,
actual PostgreSQL search semantics, citations, spelling expansion, permissions
and date limits. They include untagged production-derived examples for #3572.

## Unit lookup

A message's unit is header metadata (`unit_v2`) and links from reference
networks; it is usually absent from the message text. For unit/formation
questions the agent resolves the designation with `echo_unit_lookup` (route
`unit_lookup`, `POST /api/sigint/units`, relaxed search, 20 results) and then
makes a unit-only inbox request with `selectedUnitIds` (or exact header strings
in `selectedUnits`), in parallel with text search. Evidence is combined by
message ID; empty text search is never proof that the unit is absent. Release
`2026.10.10.4`.

## Position lookup

Release `2026.10.04.1` adds `echo_position_lookup` (route `position_lookup`,
`POST /api/positions/lookup`). For questions about where a named position, crew
or callsign is, or what is at given coordinates, the agent looks up known
locations first, then mentions with coordinates, then other mentions for
context, and reads messages by ID before citing them. See
[AI positions](../wdintel-rs/src/ai_position/README.md#lookup-api).

## Rollout

Device/file retrieval was added in `2026.10.06.1`. It searches authorized device
metadata, names, extracted contents and summaries, with pinned file citations
and bounded section reads. All derived data is stored in `wd_files`. File times
are not observation times; position lookup retains undated evidence and current
AOR boundaries. See [device documents](../wdintel-rs/src/devices/documents/README.md)
for permissions, search semantics, pipeline controls and rollout/recovery.

Release `2026.10.04.1` requires the matching Echo build, including the AI
position migrations. Release `2026.09.28.1` added no database migration.
Deploy/restart Echo first, then upgrade only the intended namespace:

```sh
just dev-tmux-restart
just ai-control-panel upgrade --host local --release 2026.10.04.1 --dry-run
just ai-control-panel upgrade --host local --release 2026.10.04.1
```

For another host, deploy that Echo build and replace `local` with its explicit
alias. Rescan and require a matching executable/release. Validate a cited
conversation before expanding rollout. Preserve the previous immutable release
and container backups for rollback; follow `CONTROL_PANEL.md` for recovery.
