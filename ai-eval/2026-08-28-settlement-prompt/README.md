# Settlement prompt — 2026-08-28

The compiled fallback prompt extracts settlement and named forest locations from the structural
header of a message without consulting settlement dictionaries. It was
derived from the documented callsign prompt rules, the current unit/location
parser fixtures, and read-only `echo-kharkiv2` examples paired with their
pipe-delimited `sigint_inbox_item.location_v2` values.

The prompt treats source-post names, dates, frequencies, coordinates,
callsigns, unit names, same-header unit aliases repeated in parentheses,
dialogue, comments, and interception tags as negative boundaries. It keeps
multiword and hyphenated names, normalizes only obvious grammatical case,
preserves source spelling, and returns ordered JSON under the `settlements`
key.

Named forests retain their full names as location text; settlement catalog
resolution may leave them undefined. Country and administrative names are
excluded, and directional adjectives do not become approximate settlement
names. The [#3383 fixtures and rollout procedure](../2026-10-09-settlement-regressions/README.md)
cover the corrected cases and the saved production override that masks this
fallback until an administrator updates or resets it.
