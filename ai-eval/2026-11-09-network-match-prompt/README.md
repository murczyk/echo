# Network match prompt — 2026-11-09

The compiled prompt for the [AI network match worker](../../wdintel-rs/src/ai_network_match/README.md)
([#4095](https://github.com/echoua/echo/issues/4095)). The worker sends one
intercepted message and its candidate networks, which were already matched by
frequency, AOR and time. Each candidate carries its callsigns, units, posts and
the analysts' «Опис для ШІ». The model returns an independent 0–100 certainty
and a short reason for each candidate key.

The prompt ranks callsign overlap and explicit analyst instructions (post,
DMR colour code, call group, subscriber ids) above weaker attributes. Without
distinguishing evidence it keeps every score low, so the message card keeps
showing all networks.

No evaluation corpus exists yet. Collect multi-network messages from
echo-pivnich under `raw/` before tuning the prompt or the confidence
thresholds in `config.rs`.

## 2026-11-11 feedback: callsigns win

An analyst on echo-pivnich reported a message whose callsign is listed only by
one candidate network, while the AI gave a frequency-only network 83% and the
callsign network 78%. The candidate frequency list was capped at 20 in
ascending order, so the message's frequency was cut from the busy network's
list and the model read it as a contradiction. Among the 3,098 messages scored
by then, 826 had such a cut list. Of 469 messages where exactly one candidate
listed a message callsign, the AI ranked another network first in 65 and
folded the card away from the callsign network in 26, mostly following a unit
or area named in the header.

The input now puts the message's own frequency, post and callsigns first,
adds the message's `callsigns` and each candidate's `matched_callsigns`, and
the prompt makes callsigns decisive and frequency neutral. The server also
picks the only callsign network as the main one regardless of the score.
