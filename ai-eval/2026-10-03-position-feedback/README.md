# AI position feedback evaluation set (#3064)

Cases for the AI position worker ([`wdintel-rs/src/ai_position`](../../wdintel-rs/src/ai_position/README.md)).
They come from reviewers marking mentions and locations in Admin → ШІ → Позиції.

- `cases.synthetic.jsonl`: tracked, hand-written cases with no operational data.
- `results.synthetic.json`: runs on 2026-10-03 with Gemma 4 26B:
  - old prompt: 6 of 12;
  - revised prompt (kinds, UAV and weapon exclusions, code-name landmarks,
    JSON repair): 11 of 12. The one miss is «ОП Лиман-2», which the model
    returned as «Лиман-2»; keys now ignore the type prefix.
  - after reparsing real data surfaced settlements written in capitals and
    crew callsigns as positions: settlement rules and hints, crew callsigns,
    and dedup of inflected repeats. 16 of 16 on the extended set.
  - plus excluding generic objects («дамба», «міст»): 16 of 17. #16, a crew's
    quoted callsigns, came back as ; it is genuinely ambiguous.

  Of the two reviewed real cases in `raw/`, «Молния» (a UAV) and «МАГАТЭ»
  (missed), 1 passed with the old prompt and 2 with the revised one.
- `raw/`: exported production feedback. It is gitignored and lives only here and
  in Backblaze B2 at `s3://echouastorage/lfs/echo-ai/evals/2026-10-03-position-feedback/`.

## Loop

1. **Review.** In «Згадки», or on a position's page, mark wrong mentions:
   - «не позиція»;
   - «неправильна назва», with the right name;
   - «неправильні координати», with the right coordinates if known;
   - «пропущено позиції», listing the missed names, comma-separated;
   - «неправильний тип»: position, crew (розрахунок) or callsign;
   - «правильно» for good examples worth keeping.

   Each verdict snapshots the text, span, coordinates and model, so later
   reparsing does not change the case.
2. **Pull the cases** from a server into `raw/` and upload them to B2:

   ```sh
   just ai-position-feedback-pull --server echo-cbr-staging
   ```

   This runs `wdintel-rs ai-position-feedback-export` on the server, copies
   the JSONL here as `raw/<server>-<timestamp>.jsonl`, removes the remote copy
   and syncs to B2. On another machine, `just ai-eval-sync-from-cloud
   2026-10-03-position-feedback` restores them. Credentials come from `.env`
   (see [ai-eval/README.md](../README.md)).
3. **Improve** the prompt
   ([`2026-10-02-position-prompt/prompt.txt`](../2026-10-02-position-prompt/prompt.txt))
   or the grounding in `wdintel-rs/src/ai_position`.
4. **Replay** the cases through the real extraction and grounding:

   ```sh
   just ai-position-eval /path/to/private-engine.json ai-eval/2026-10-03-position-feedback/raw/<file>.jsonl --output /tmp/results.json
   just ai-position-eval /path/to/private-engine.json   # the synthetic cases
   ```

   Add `--prompt <file>` to try a prompt before it ships. The engine file is
   private JSON with `url`, `model_name` and an optional `token`. Never commit
   it.
5. **Ship and reparse.** Deploy the improvement, then press «Перепарсити
   відгуки» in «Згадки»: every source with feedback not re-run yet is
   extracted again and its feedback is marked as re-run.

## Scoring

| Verdict | Passes when |
| --- | --- |
| `correct` | the position is found with the reviewed coordinates (and kind, if recorded) |
| `not_position` | the name is not extracted |
| `wrong_name` | the wrong name is gone and the expected one (if given) is found |
| `wrong_coordinates` | the reviewed coordinates are no longer tied to it, and the expected ones (if given) are, within 50 m |
| `missed` | every listed name is found |
| `wrong_kind` | the name is found with the expected kind |

Location feedback, cases without text and `other` are reported as skipped.
Review them by hand.
