# AI positions

Finds named positions («Циркон 9», «ЦИРКОН-9», «ОП Лиман») in messages and
document summaries, highlights them in message cards, and records the
coordinates a text ties to a position.

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
mention's time must fall within the window. The card only uses knowledge built
entirely from groups the viewer can read. The admin page hides mentions and
knowledge of private groups the admin cannot read.

Changing a group's AORs takes effect at the next recompute of each position.

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
