# Evaluation memory

Durable observations from the first prompt iteration:

- Both review sources only removed parsed callsigns; they added no missing
  callsigns. The dominant observed problem is false positives.
- Common failures are dictated coordinates/codes, unaddressed numbers, objects,
  directions, and ordinary nouns interpreted as participants.
- Stronger evidence gating substantially improves precision, but an absolute
  direct-address requirement loses real callsigns in noisy or foreign speech.
- `batch-01` is newer and overrides the larger WIP review for duplicate source
  messages. Unresolved duplicates in the same priority remain excluded.
- Future work should start from candidate 01 and target false-negative recovery
  on the validation split before changing the full selected prompt.
