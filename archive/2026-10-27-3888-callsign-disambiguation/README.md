# Callsign header disambiguation

Issue [#3888](https://github.com/echoua/echo/issues/3888). Read-only investigation
of `echo-pivnich` and `echo-skhid` on 2026-10-27. Both servers ran
`wdintel-rs 0.1.1~rc.202610261229-1`, with the GLM-5.3 callsign worker enabled
and no prompt override.

Body-based disambiguation can resolve some headers containing multiple words,
but cannot resolve every transcript. Changing the prompt alone is insufficient
where the regular parser already supplies an incorrect combined candidate.

## Confirmed examples

Message IDs identify the original records; full intercepts are not copied here.
The database spelling is `САКСОФОН КОНТРОЛЬ`.

| Case | echo-pivnich message | echo-skhid message | Evidence |
| --- | --- | --- | --- |
| One multiword callsign | `34151870` | `42866627` | The body addresses `САКСОФОН КОНТРОЛЬ` as a unit, followed by a separate numeric participant. |
| Three callsigns without commas | `36053199` | `45827775` | Header `ЗАНОЗА КАЛЬЯН ЧЕМОДАН`; separate body passages address Заноза, Кальян, and Чемодан. Only `928` was extracted when sampled; both jobs remained queued. |
| Another genuine multiword callsign | — | `47102982` | Header `СОРОК СЕДЬМОЙ`; the body repeatedly says `я Сорок седьмой` and addresses that full name. |
| Insufficient body evidence | `36355101` | `46270916` | Header contains `САКСОФОН КОНТРОЛЬ`, but the body does not repeat it. The body alone cannot determine the header's segmentation. |
| Abbreviated use | `36910092` | `47103162` | The same aviation context also uses `САКСОФОН` and the inflected `Саксофону`; a shorter form does not itself establish a different participant. |

The recorded exact active spelling `саксофон контроль` occurred in 3,139
callsign rows on pivnich and 346 on skhid. These are spelling-specific row
counts, not counts of errors or complete coverage of the underlying station;
hyphenated and shortened forms also occur.

## Current behavior

- The [default prompt](../../ai-eval/2026-08-10-callsign-prompt/prompt.txt)
  prioritizes the header, includes each header line whole, and explicitly
  prohibits splitting multiword names. It already names `САКСОФОН КОНТРОЛЬ`
  as a positive example.
- [AI extraction](../../wdintel-rs/src/ai_callsign/mod.rs) receives the whole
  original message, including the header and body. Supplying the body is
  already implemented.
- `parse_with_feedback` unions regular-parser candidates with AI output through
  `merge_current_and_ai_callsigns` in the
  [worker](../../wdintel-rs/src/ai_callsign/worker.rs). AI cannot remove an
  incorrect regular-parser candidate through that union.
- The regular parsers have format-specific restrictions; for example, the
  aviation literal-name pattern does not accept two alphabetic words separated
  by a space. Some valid multiword names therefore depend on later AI work.

## Suggested implementation

1. Identify ambiguous spans inside the callsign header, retaining their text
   and boundaries. Do not interpret every multiword sequence in the message as
   a callsign header: unit descriptions, locations, and metadata also contain
   multiple words.
2. Ask AI to resolve each ambiguous span using explicit participant roles in
   the body: independent calls, direct addresses, and self-identifications.
   Mere word occurrence or repetition is insufficient. Permit mixed results,
   such as one multiword callsign beside another participant.
3. Preserve a full name when the body addresses or identifies it as a unit.
   Account for inflection and abbreviated calls without assuming that each
   component is a separate participant. Keep numeric suffixes, hyphenated
   names, and established explicit delimiters intact.
4. Treat insufficient or conflicting evidence as unresolved. Retain the
   original span for review rather than asserting a split or promoting a
   guessed combined name as confirmed. The exact review UI and storage need
   a product decision.
5. Change the merge only for candidates belonging to resolved ambiguous
   spans. Preserve unambiguous parser results and explicit user overrides;
   do not let AI replace the entire authoritative parser result globally.
6. Validate AI output against the original span and supporting body text,
   including evidence for each split component. Reject unsupported additions.

## Evaluation before rollout

Use the identified messages as initial fixtures, then build an independently
reviewed corpus containing true multiword names, missing commas, mixed spans,
numeric suffixes, grammatical inflections, abbreviations, explicit lists,
metadata, incomplete bodies, and conflicting evidence. Evaluate false splits,
false joins, extra candidates, missed candidates, and unresolved cases
separately; repeat AI evaluations to measure stability.

No revised-prompt accuracy was measured during this investigation. Any future
deployment, production prompt change, or historical reprocessing requires
explicit approval naming the operation and target. Queue delay is investigated
separately in [worker-delay.md](worker-delay.md).

The subsequent monitoring/fallback implementation and validation are recorded
in [ai-queue-implementation.md](ai-queue-implementation.md), with
[query plan evidence](monitoring-query-review.md).
