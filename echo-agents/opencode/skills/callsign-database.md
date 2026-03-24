# Callsign Database

Use this when a candidate looks misspelled, OCR-damaged, or ambiguous.

Primary command:

```bash
${ECHO_AGENT_BIN:-echo-agent} api callsigns-search "<QUERY>"
```

Examples:

```bash
${ECHO_AGENT_BIN:-echo-agent} api callsigns-search "МРНЫЙ"
${ECHO_AGENT_BIN:-echo-agent} api callsigns-search "МИРНЫЙ"
${ECHO_AGENT_BIN:-echo-agent} api callsigns-search "ШЫШ"
```

Check:

- exact or near-exact spellings in `callsigns`
- `position`
- `comment`
- `radio_freq`
- whether one spelling is clearly more plausible than another

Use the database as supporting evidence, not as the only source. The target message still decides who is actually speaking.
