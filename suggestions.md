# Review suggestions

- [x] Preserve the existing network-scoped inbox callsign lookup. Treating a
  missing `network_ids` value as an empty scope makes `load_callsigns` query all
  networks and can attach unrelated network hints to otherwise unlinked inbox
  messages. Resolve Iggy callsign dictionary IDs independently instead.
- [x] Move the new Iggy enrichment query batch size into `config.rs` with the
  existing `API_INTEGRATION_IGGY_*` constants instead of hard-coding `20000`.
- [x] Exclude frequencies belonging to soft-deleted networks. The new lookup
  filters deleted frequency rows but can still emit IDs through stale
  `sigint_inbox_item_network` links after their parent network is deleted.
- [x] Split the 150-line enrichment test into focused fixture helpers so the
  contract assertion remains short and each setup step is self-descriptive.
- [x] Assert the enriched IDs on the serialized event itself. Checking only the
  intermediate Rust fields would still pass if serialization omitted or
  misplaced one of the new public JSON keys.
- [x] Cover the documented active-period selection with an out-of-period
  frequency fixture; the current happy path would pass even if the timestamp
  join condition were accidentally removed.
