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
