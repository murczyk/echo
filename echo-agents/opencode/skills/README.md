# ECHO Agent Skills

These skills are local reference notes for `sigint-extract-callsigns`.

- `same-frequency-context.md`: inspect nearby traffic on the same frequency, linked networks, and network callsigns.
- `callsign-database.md`: search known callsigns in ECHO to confirm spellings and normalize typos.
- `speaker-extraction-heuristics.md`: rules for distinguishing actual speakers from mentions and header noise.

Helpers are exposed through the agent binary:

```bash
${ECHO_AGENT_BIN:-echo-agent} api message-by-id --message-id 123
${ECHO_AGENT_BIN:-echo-agent} api same-frequency-context --message-id 123
${ECHO_AGENT_BIN:-echo-agent} api callsigns-search "МИРНЫЙ"
${ECHO_AGENT_BIN:-echo-agent} api network-info 5 6
${ECHO_AGENT_BIN:-echo-agent} api network-callsigns --network-id 5
```
