# Callsign feedback regression fixtures (#3167)

`cases.json` contains examples supplied in [issue #3167](https://github.com/echoua/echo/issues/3167)
and one explicitly synthetic legitimate-callsign contrast. The numeric-template
case uses a synthetic coordinate-removal history. No restored message corpus or
engine credentials are checked in.

On 2026-09-06, the configured vLLM engine from the nightly restore was exercised
with the repository default prompt and the new feedback prompt. Each candidate
with feedback received a second request containing three prior removals and one
example. Template results were unioned independently. `results.json` records the
five final passes and request timings; this small check is not a corpus-wide
accuracy estimate. The initial feedback prompt still accepted ФИПКА; the revised
prompt explicitly gives matching negative contexts precedence over an ambiguous
mention, while allowing clear independent radio identification.

The fixtures' `templates` values are supplied to the evaluator; the Rust regression
suite separately exercises actual template extraction, request gating and budgets.

To rerun against an authorized engine, provide a private JSON file with `url`,
`model_name`, and optional `token`, using the same fields as `ai_engine`:

```sh
python3 ai-eval/2026-09-06-callsign-feedback/evaluate.py /path/to/private-engine.json
```

The evaluator prints only callsign decisions, durations and HTTP status on error.
It does not print credentials, URLs, or provider error bodies.
