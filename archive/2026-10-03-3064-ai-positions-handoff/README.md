# #3064 AI positions: implementation handoff

Recorded on 2026-10-03 for [#3064](https://github.com/echoua/echo/issues/3064).
This records the AI position extraction feature, its review history, the
feedback and evaluation loop, and how to continue elsewhere. It contains no
operational records or credentials.

## Start here

- Branch `3064-ai-positions`; base `main`; PR
  [#3651](https://github.com/echoua/echo/pull/3651). The branch was deployed
  before the feedback work.
- Read the [worker and access model](../../wdintel-rs/src/ai_position/README.md)
  and the [evaluation set](../../ai-eval/2026-10-03-position-feedback/README.md).
- Migrations:
  - `m20261002_192628_ai_position_parsing`: tables, triggers and the
    `sigint_inbox_item (datetime, id)` index. It is deployed: never edit it.
  - `m20261003_041306_ai_position_feedback`: the `ai_position_feedback` table.

## What is implemented

**Extraction**
- One structured model call per message body or completed OCR summary.
- Deterministic grounding: names must occur in the text (variant- and
  inflection-tolerant key); coordinates must be found by milgeo in the text.
- Mentions and coordinate facts carry the message's event time, group and AORs.

**Knowledge**
- Built per AOR (non-private groups only) and per group.
- 30-day window, a 300 m clustering grid, certainty and recency weights, and
  conflict detection.
- New facts queue recomputes. Newly covered time ranges queue resumable link
  jobs, which mark the name in the scope's other messages without a model call.

**Access**
- Every read uses the current group privacy and AOR membership.
- Cards show knowledge only if the viewer can read every source group.
- Admin pages hide private groups the admin cannot read.

**Freshness**
- Database triggers keep facts current on every write path:
  - body edits;
  - deletion and restaging;
  - event-time edits;
  - summary changes and deletion;
  - group-link changes and merges;
  - attachment moves;
  - privacy flips, including the importer;
  - AOR links and AOR deletion.

**UI**
- Message cards highlight positions; the tooltip shows the coordinates or the
  known location.
- Admin «ШІ → Позиції»:
  - «Згадки», with filters including «З координатами» and «Відгук»;
  - «Відомі позиції», linking to each position's page;
  - a position's page with its location, location feedback and its
    interceptions;
  - «Налаштування»: prompt, engine, test run, background backfill.

**Feedback and evaluation**
- Verdicts are kept with a snapshot of the case.
- «Перепарсити відгуки» re-runs the reviewed sources.
- `wdintel-rs ai-position-feedback-export` and `ai-position-eval`, wrapped by
  `just ai-position-feedback-pull --server <server>` and
  `just ai-position-eval <engine.json> [cases]`.

## Evidence

- `cargo test ai_position`: 27 passed. This covers grounding variants,
  consolidation (including 20k reports), AOR sharing, private isolation, group
  moves, link replacement, deletion and restore, body and time edits, Latin
  look-alike linking, AOR reassignment, and the feedback snapshot and reparse.
- Codex: eight local review rounds plus the GitHub bot review, all addressed.
  The PR description has the linking query plans (index-only scans, under
  1 ms per 500-id batch locally).
- Live on local dev with Gemma 4 26B: the «Циркон 9» example, linking of
  «ЦИРКОН-9 на зв'язку», and no leak from a private group's «Береза 3».
- Synthetic evaluation baseline: 3 of 6 pass (`results.synthetic.json`).
  - #3: target coordinates were attached to a position.
  - #4: inflected and «ОП …» names were missed.
  - #6: malformed JSON from the model.

  These are the first things to improve once real feedback arrives.

## Open items

- `.env` here has only read-only B2 keys. `ai-position-feedback-pull` saves the
  export locally but its upload step needs `ECHOUASTORAGE_LFS_AWS_*` write keys.
- Model JSON failures currently retry the job. A tolerant parse or a repair
  request would help small models.
- Message-time linking (pass 1) scans messages created since the range start;
  it is batched and resumable, but long histories take a while.

## Follow-up on 2026-10-03: first feedback

Reviewer feedback on local dev:
- «Молния» was taken as a position, and spread by linking. It is a UAV type,
  first extracted from «МЗП FPV-ЛТ "МОЛНИЯ"…».
- «МАГАТЭ» was missed.

**Changes**
- Migration `m20261003_111926_ai_position_kind`: `kind`
  (`position`/`crew`/`callsign`) on mentions, knowledge and feedback; the
  «неправильний тип» verdict; indexes for rejected names and for
  coordinates by place.
- Revised prompt with kinds, UAV and equipment exclusions, code-name
  landmarks and nominative names. A one-shot JSON repair for malformed
  replies.
- Grounding: vowel-stem inflections («Березі 3»), and type-prefix-free keys
  («ОП Лиман-2» = «Лиман-2»).
- «не позиція» now excludes the name everywhere (delete, extraction, linking,
  knowledge).
- Located crews and callsigns keep the callsign pill and add a location
  marker.
- Lookup API `POST /api/positions/lookup`, with three tiers and caller-group
  access. Admin lists gained `near`, `from`/`to` and `kind` filters.
- Harness `2026.10.03.1` adds the `echo_position_lookup` tool and search
  guidance.

**Evaluation (Gemma 4 26B)**
- Synthetic cases: 6/12 with the old prompt, 11/12 with the revised one.
- Real reviewed cases: 1/2 before, 2/2 after.

`raw/local-dev-20261003.jsonl` holds the two real cases locally; uploading
needs B2 write keys.
