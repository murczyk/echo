# Same Frequency Context

Use this when you have a message id and need context from nearby traffic on the same frequency.

Primary command:

```bash
${ECHO_AGENT_BIN:-echo-agent} api same-frequency-context --message-id <MESSAGE_ID>
```

Optional knobs:

```bash
${ECHO_AGENT_BIN:-echo-agent} api same-frequency-context \
  --message-id <MESSAGE_ID> \
  --hours-before 24 \
  --hours-after 24 \
  --limit 40
```

What to inspect:

- `target_message`
- `same_frequency_messages`
- `message_networks`
- `message_network_callsigns`
- `frequency_matched_networks`

Use this context to tell apart:

- actual speakers in the target dialogue
- third-party mentions
- repeated callsigns that are common on the same frequency
- callsigns already assigned to a linked network
