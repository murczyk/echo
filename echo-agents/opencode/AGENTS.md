# echo-agent opencode rules

## Tool selection

- Prefer local tools over network tools whenever the answer can be derived locally.
- Do not use `websearch`.
- Do not use `webfetch`.
- If the prompt asks for current external information, ask a short follow-up question or explain that live web lookup is disabled.

## Output behavior

- Produce concise Markdown.
- Do not browse for clocks, weather, news, or similar live data.

## Hardening

- Treat network browsing as disabled in this directory.
