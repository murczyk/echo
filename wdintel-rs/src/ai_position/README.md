# AI positions

Finds named positions («Циркон 9», «ЦИРКОН-9», «ОП Лиман») in messages and
document summaries, highlights them in message cards, and records the
coordinates a text ties to a position. Each name has a kind:

- `position`: a post, observation point or code-named landmark;
- `crew`: a crew or group tied to a place («розрахунок … ймовірно Рикки»);
- `callsign`: a callsign, kept only when the text places it.

UAV, munition and equipment names («Молния», «Ланцет») and settlements are
excluded by the prompt. Settlements Echo already found in a message are passed
to the model as a hint. Single generic words («дамба», «посадка», «міст») are
dropped in code; with a number or code («Дамба-3») they count as names. A located crew or callsign that overlaps a callsign token in a
message card keeps the callsign pill and its hint, and adds a location
marker.

Keys ignore a leading post type («ОП Лиман-2» = «Лиман-2»). Feedback annotates
an individual mention or a scoped location; it never deletes mentions or
blacklists a name. The same word can denote a position, a callsign or an
ordinary object in different messages. All cases remain available for review
and evaluation; improve the prompt and reparse sources to correct extraction.

Position mentions, coordinate facts, known locations, feedback and worker/link
jobs use database-generated UUIDv7 IDs. API IDs, pagination cursors and position
page URLs carry UUID strings; existing message and AOR identifiers are unchanged.

Located position highlights use the same styling as palette points. They join
the message's coordinate preview alongside direct coordinates, palette points
and document coordinates. Clicking a position opens that complete map focused
on its location; hovering shows the shared overview/detail map preview. Recognized
document positions also join the message map, using their own or known coordinates.
Clicking the map thumbnail fits all points. Positions without
coordinates keep their tooltip without opening a map.

The map's coordinate card links to the message supporting those coordinates,
with the same hover preview as AI citations. Sources must belong to a current,
accessible group and an undeleted message; knowledge sources must also match
the displayed MGRS, scope and fact window. The message preview rechecks access.

Copied message links prefer the message UUID. Legacy local/test data missing
UUIDs can be repaired with `target/debug/wdintel-rs --mode=debug oneoff-backfill-signal-message-uuid --reset-checkpoint`;
the existing backfill preserves assigned UUIDs and fills related references.

## What is stored

- `ai_position_mention`: every occurrence of a position name in a message
  body or an OCR document summary (`media_summary.summary`), with character
  offsets, the variant-insensitive `name_key` («циркон 9»), the message time,
  and the message's group, whether it is private, and its areas of
  responsibility (AORs).
- `ai_position_coordinate`: a fact that the text ties a position to
  coordinates (MGRS and WGS84), with certainty `high|medium|low`, a short
  evidence quote and the message time.
- `ai_position_knowledge`: where each position is, consolidated per scope.

The model only proposes names and coordinates. The worker keeps a name only if
it occurs in the text (`normalize.rs`: case, separators and Latin look-alike
letters are ignored, common case endings are allowed). It keeps a coordinate
only if milgeo finds the same point (within 50 m) in the text. A coordinate
far from every occurrence of the name, or separated from it by a blank line,
drops to `low` certainty.

## Knowledge and access

A new or removed coordinate fact queues a recompute (`ai_position_knowledge_job`)
for every scope its group can feed: the group itself and each of its AORs.
Every recompute and every read uses the group's privacy and AOR membership as
they are now, not as they were when the message was parsed. Private groups
never feed AOR knowledge.

When a recompute makes a position known, or widens its window, it queues
`ai_position_link_job` rows for the newly covered event-time ranges. The
worker advances each one batch at a time, each batch in its own transaction:

1. It seeks message ids by event time (`sigint_inbox_item.datetime`; messages
   without a parsed time by `signal_message.created_at`).
2. It keeps only messages of the scope whose body contains the name, and adds
   a mention without a model call (`model_name = knowledge`). The message worker likewise marks names its
scopes already know, even when the model reads them as callsigns
(«ЦИРКОН-9 на зв'язку»).

Database triggers keep facts in step with their sources on every write
path, whether or not the worker is enabled:

- a changed message body drops the message's mentions, since their offsets
  point into the old text; the edited text is then extracted again;
- deleting or restoring a message, or changing its event time, moves its
  facts' times and recomputes their knowledge. Reads leave out deleted
  messages, so a message restored after restaging keeps its facts;
- a changed or deleted document summary (OCR reprocessing) drops that
  document's mentions;
- a message that moves to another group (e.g. a group merge) moves its
  mentions too, and both groups' knowledge is recomputed;
- an attachment moved to another message takes that message's group and
  time;
- a group made private or public on any path (zone settings, importer)
  recomputes the knowledge its facts feed;
- any removed mention, including cascades from removed attachments, queues
  the knowledge it may have fed for a recompute.

A recompute considers facts from the 30 days before the position's latest fact.
Facts within 300 m count as one place, weighted by certainty and recency
(half-life 7 days). A second place with at least half the weight marks the
knowledge as conflicting. The tunables are in `config.rs`
(`AI_POSITION_KNOWLEDGE_*`).

When a mention in a message card has no coordinates of its own, the card shows
the knowledge for the mention's scopes. AOR knowledge is preferred, and the
mention's time must be no earlier than the start of the window. Later mentions
retain the last known location even after 30 days, with its source date and
conflict indication; this does not claim a newly confirmed position. The card only uses knowledge built
entirely from groups the viewer can read. The admin page hides mentions and
knowledge of private groups the admin cannot read.

Changing a group's AORs, or deleting or restoring an AOR, recomputes the
affected positions in the old and new AORs.

## Lookup API

`POST /api/positions/lookup` searches by `name`, by `coordinates` (MGRS, SK-42,
lat,lng) with `radiusMeters`, or both, over the last `days` (default 30). It
returns three tiers, all limited to the caller's groups:

1. `known`: consolidated locations (knowledge built only from groups the
   caller can read);
2. `located`: mentions with coordinates;
3. `other`: mentions without coordinates, for context. With coordinates only,
   these are other mentions of the nearby known positions.

The AI agent uses it as `echo_position_lookup` (route `position_lookup`,
harness `2026.10.04.1` or later). The admin lists accept the same `near`
(«<coordinates>|<metres>») and `from`/`to` (dates) filters, plus `kind`.

## Feedback and evaluation

Reviewers mark mentions («Згадки», or a position's page `/admin/ai/positions/<id>`
listing its interceptions) and locations (on a position's page) as correct, not
a position, wrong name, wrong coordinates, missed positions, or other. Each
mark has an expected value and a comment, and is stored in
`ai_position_feedback` with a snapshot of the case.

The admin page can re-run extraction for one source, or for every source with
feedback not re-run yet («Перепарсити відгуки»). The evaluation set and the
improve–replay–reparse loop are in
[`ai-eval/2026-10-03-position-feedback`](../../../ai-eval/2026-10-03-position-feedback/README.md).

## Display rollout

Admin → System settings → Основні → «Показувати ШІ-позиції всім користувачам»
controls display in Duty and Analysis. It defaults to off, including existing
installations. Settings → Оперативний or Аналіз → Картка повідомлення →
«Показувати ШІ-позиції (експериментально)» lets individual users opt in while
that global flag is off. Enabling the global flag shows positions for everyone.

The flags apply when messages are loaded; reload an open feed after changing
them. When display is off, message responses omit AI position highlights and
AI coordinates from both body and attachments. Ordinary coordinates and palette
points remain available. Extraction, knowledge/link workers, admin review,
position lookup and AI-agent tools continue working independently.

## Operating

1. Apply migration `m20261002_192628_ai_position_parsing`.
2. Admin → ШІ → Позиції → Налаштування:
   1. Enable the worker and pick an engine that has the callsign capability.
   2. Check the prompt on a sample message with «Перевірити з поточним
      промптом».
3. «Обробити наявні» queues messages and completed document summaries from the
   last N days (up to 90) in the background. Watch progress in «У черзі». New
   messages and newly completed summaries are queued automatically while the
   worker is enabled.

The default prompt is
[`ai-eval/2026-10-02-position-prompt/prompt.txt`](../../../ai-eval/2026-10-02-position-prompt/prompt.txt).
A saved prompt overrides it until it is reset to the standard one.

The tables are excluded from analytics replication because they may hold
private-group points.
