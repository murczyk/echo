# Legacy Office attachment-preview evaluation

## Current implementation

Echo previews Word 97--2003 `.doc` and BIFF8 `.xls` attachments in the shared
Duty Neo and Analysis Neo message-card dialog. Attachment extension and MIME
type select a preview path only; a 10 MiB CFB/format preflight is the trust
boundary. Parsing runs in disposable module workers, with bounded download and
parent parse deadlines. The main thread validates a bounded DTO and React
renders only application-owned text, list, table, and spreadsheet-grid nodes.

The retained JSDoc and LibreOffice Writer DOC fixtures, LibreOffice Calc XLS
fixture, and Apache POI XLS fixtures are the current compatibility evidence.
The LibreOffice XLS fixture uses a currency format with an explicit `$` locale
symbol. Its locale-only percentage tag is ignored by the vendored SheetJS
formatter, so it displays `25.00%`, not a currency-prefixed percentage.

## Security boundary

Before a candidate parser is called, CFB validation checks physical sector
bounds; exact FAT, DIFAT, mini-FAT, directory and stream chains; cycles,
overlaps, duplicate ownership, markers, and role conflicts. DOC FIB/CLX and
BIFF8 record framing are validated. Encrypted files, macros, embedded OLE,
external workbook references, hyperlinks, and unsafe drawing/object records
are rejected. Drawing payloads that meet the bounded BIFF placement/framing
rules are skipped and never enter the preview DTO.

The production worker assets receive a restrictive per-worker CSP, duplicated
in all 12 standalone Echo nginx site configurations. In particular,
`connect-src 'none'` prevents worker network egress and `worker-src 'none'`
prevents nested workers. Qualification timings cover worker creation through
result delivery, not parser-only execution.

## Deliberate limitations

The preview does not provide Word pagination, editing, images/media, macros,
VBA, embedded OLE, external links, formula calculation, drawings, headers,
footers, comments, notes, text boxes, tracked changes, or exhaustive support
for historical Office producers. Invalid or unsupported files show a Ukrainian
preview error while preserving the regular download action.

## Historical candidate findings

Earlier tests of unmodified upstream SheetJS and JSDoc found unsafe CFB/DIFAT
handling. Those findings are historical evidence only: the shipped path uses
the local CFB and BIFF/DOC validation boundary plus patched vendored sources.
