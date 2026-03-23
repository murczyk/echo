# echo-agent project rules

## Tool selection

- Prefer local tools over network tools whenever the answer can be derived locally.
- Do not use `websearch` for this project.
- Do not use `webfetch` for this project.
- If the prompt needs external information, ask a concise follow-up question instead of browsing.

## Output behavior

- Produce concise Markdown without wrapping the whole answer in a code fence.
- Ask for missing location or context instead of inventing external facts.

## Hardening

- Treat network access as disabled for this project.
- Prefer deterministic local commands over inferred live-web answers.
