# Settlement prompt — 2026-08-28

The compiled fallback prompt extracts settlement names from the structural
header of a SIGINT message without consulting settlement dictionaries. It was
derived from the documented callsign prompt rules, the current unit/location
parser fixtures, and read-only `echo-kharkiv2` examples paired with their
pipe-delimited `sigint_inbox_item.location_v2` values.

The prompt treats source-post names, dates, frequencies, coordinates,
callsigns, unit names, same-header unit aliases repeated in parentheses,
dialogue, comments, and interception tags as negative boundaries. It keeps
multiword and hyphenated names, normalizes only obvious grammatical case,
preserves source spelling, and returns ordered JSON under the `settlements`
key.
