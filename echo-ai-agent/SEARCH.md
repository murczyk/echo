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
existing 31-day request cap. The runner, not the tool schema, enforces the cap,
so a call for a longer period is refused with the exact `date_range` windows of
at most 31 days that cover it, newest first (#4179). User-specified
periods and group restrictions are preserved. Errors and incomplete pagination
must never be described as proof that no evidence exists.

The [harness evaluations](../ai-eval/HARNESS.md) exercise both retrieval paths,
actual PostgreSQL search semantics, citations, spelling expansion, permissions
and date limits. They include untagged production-derived examples for #3572.

## Group scope

Users name a source group as чат, чатик, канал or група. The model passes that
name in `selectedGroups`, and the runner resolves it to group keys before the
request runs, from one group list per request. See `runner/group-scope.ts`.

Matching takes an exact key, then an exact name, then a case-insensitive name. A
name shared by several groups selects all of them, as the UI does. A value that
matches nothing, or matches names differing only in case, rejects the call with
the accessible names to choose from. Nothing is matched fuzzily, and a failed
group list rejects the call, because passing the raw value on would read as "no
messages" in a group that exists. Echo also returns nothing for a selection with
no accessible group, so a scope cannot silently widen.

Once a request selects a group, even one that was rejected, a read that omits the
selection is refused. Naming another group stays allowed, and `messageIds` pin a
read to known messages. If a model wrongly scopes a plain subject, it therefore
cannot fall back to an unscoped search in that request; the user sees "not found",
which is safer than a silently wrong scope. Each request starts fresh, so a
follow-up relies on the prompt, and the evaluations measure it. Bounded research
passes the groups it read and any group problems to synthesis, which writes the
final answer.

Known limits: `position_lookup` and `messages_by_id` have no group filter, so they
are not scoped, and the `messageIds` exemption trusts the IDs it receives. On
engines without bounded research, a budget stop can omit a rejected group from the
final answer; the answer is still marked as limited coverage and never widens.

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
Since `2026.11.16.1` (#4224), search hits omit default states and the full path,
and synthesis can cite file and attachment search hits even when no file was
read, so a search-only request is no longer reported as having no evidence.

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
