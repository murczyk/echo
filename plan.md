# Historical RER CSV import with preflight

## Scope and previous behavior

- This plan covers the one-column RER CSV flow at `/admin/rer-csv-import` and
  `POST /api/rer/csv-import`. Delta CSV/KMZ imports are out of scope.
- The previous page opened a file picker and started the import immediately.
- The previous importer trimmed and ignored empty CSV records, inserted every
  non-empty record, sets `signal_message.timestamp` to the current UTC time,
  and leaves `signal_message.created_at` to its database default.
- Inbox construction separately parses the interception time from the body and
  stores it in `sigint_inbox_item.datetime`. Historical import must therefore
  parse before inserting and use the parsed instant for both signal-message
  fields.
- `signal_message.created_at` also drives message UID generation, Duty Neo
  ordering, unread state, and notifications. No database migration is needed;
  the field is already writable.

## Confirmed decisions

- The web UI exposes historical import only; it sends
  `?isHistorical=true`. The backend defaults an omitted flag to historical and
  retains explicit `false` only for compatibility.
- Preflight is enforced by UI state, not by a server-side token. Import uploads
  the same browser `File` again and reparses it independently before writing.
- Timestamp parsing uses the production inbox parser and the configured Echo
  timezone. Date-only messages are valid historical records at `00:00` local
  time on the parsed date.
- Preflight counts only non-empty CSV records and unlocks Import after every
  successful preflight, including when all records will be skipped.
- Skipped-record logs contain the CSV record number and a bounded one-line
  preview; the downloadable CSV contains the complete bodies.
- A CSV record which would be split into multiple signal messages is invalid
  for this flow and must be rejected before insertion.
- A body over 20,000 characters which the current splitter cannot split is also
  invalid. Preflight returns all skipped bodies in one
  `<source-stem>-skipped-messages.csv`, with separate missing-timestamp and
  invalid-size counts reflected in the Ukrainian warning.
- The shared `oneoff-rer-csv-import` CLI is historical by default and retains an
  explicit import-as-new option.
- Delta CSV/KMZ imports remain unchanged. User-facing copy remains Ukrainian.
- Delivery is tracked by [#3650](https://github.com/echoua/echo/issues/3650)
  and the feature branch is based on `main`.

## Implementation checklist

Implementation and the planned regression coverage are complete. No open
questions remain.

### 1. Share CSV and timestamp parsing

- [x] Extract the existing one-column, no-header CSV loading into a reusable
      helper used by both preflight and import. Preserve record order, normalize
      CRLF as today, trim bodies, ignore empty bodies, and retain a one-based
      source-record number for diagnostics.
- [x] Extract/reuse the production inbox datetime parser instead of creating a
      CSV-only regex. Preflight, historical insertion, and inbox construction
      must agree on accepted formats, future-date normalization, and special
      message formats.
- [x] Preserve the parser's precision result: messages containing only a date
      are valid for historical CSV import and resolve to local midnight, while
      messages from which no date can be resolved remain invalid.
- [x] Make the parser accept a fixed reference time so every record in one
      preflight/import run uses the same date/year inference rules and tests do
      not depend on wall-clock time.
- [x] Convert the parsed local time using the configured application timezone
      (currently Kyiv) and store the resulting UTC-naive instant in the
      database; do not store the local naive value directly.
- [x] Treat both `Ok(None)` and parser errors as an unparseable/missing
      timestamp for historical import, while keeping malformed CSV structure as
      a request/task error rather than silently skipping the whole file.
- [x] Return enough internal detail to distinguish valid records from skipped
      records without parsing a body more than once within a phase.
- [x] Expose a side-effect-free check based on the existing multi-message
      splitter so preflight and import can reject a CSV record that would spawn
      more than one signal message before any database write.

### 2. Add the preflight endpoint

- [x] Add `POST /api/rer/csv-import/preflight`, protected by the same
      `ensure_message_write` authorization and multipart size/timeout limits as
      the import endpoint.
- [x] Keep preflight read-only: it must not create a background task, signal
      message, inbox item, cache event, or temporary database state.
- [x] Parse every non-empty CSV message with the shared historical timestamp
      parser and split check, and calculate the agreed per-reason and aggregate
      counts.
- [x] Serialize every failed message, in original order, into a new one-column,
      no-header CSV using the CSV writer so multiline bodies and delimiters are
      quoted correctly.
- [x] Return the failed-message CSV as the response body and return the counts
      in stable response headers. Include `Cache-Control: private, no-store`
      and a safe filename such as
      `<source-stem>-skipped-messages.csv`.
- [x] Return an empty body when there are no failed messages; the client must
      not trigger an empty download.
- [x] Register the endpoint in the server and add it to authorization coverage
      so read-only/viewer users cannot use preflight as an upload side channel.

### 3. Make import historical-aware

- [x] Extend the standard CSV import request with `isHistorical`; the web page
      will always send `?isHistorical=true`, an omitted flag defaults to true,
      and the page will not expose a mode toggle.
- [x] Pass the flag into the background-task input explicitly rather than
      relying on UI state after the task has started.
- [x] For `isHistorical = true`, parse each body before any database insert. If
      parsing fails or the body would split into multiple messages, append a
      warning containing the source-record number and bounded preview to the
      background-task log, increment the appropriate skipped count, and
      continue without creating `signal_message`, `signal_message_group`,
      inbox, search, or fanout records.
- [x] For a valid historical record, set both
      `signal_message.created_at = parsed_utc` and
      `signal_message.timestamp = Some(parsed_utc)` explicitly.
- [x] Generate `id_uuid` and `message_uid` from the historical creation time as
      the existing helpers already do, and verify that
      `signal_message_group.created_at` inherits the inserted message's
      historical value.
- [x] Keep the downstream inbox parsing/fanout/search workflow unchanged for
      successfully inserted records, while verifying that
      `sigint_inbox_item.datetime` resolves to the same instant for ordinary
      CSV messages.
- [x] Assert that historical CSV records rejected by the split check never
      reach the existing oversized-message spawning path; leave splitting for
      other ingestion sources unchanged.
- [x] Preserve the current “import as new” behavior behind
      `isHistorical = false` for API/operational compatibility, even though the
      web UI no longer exposes it.
- [x] Make `oneoff-rer-csv-import` historical by default and add an explicit
      CLI import-as-new option that maps to `isHistorical = false`.
- [x] Add final task-log totals for parsed, imported, and skipped messages, in
      addition to the required per-record skip warnings.

### 4. Replace the immediate-import UI flow

- [x] Change `Pages.Admin.RerCsvImport` to hold the selected `File` and an
      explicit preflight state (`not run`, `running`, `passed`, or `failed`) in
      its model.
- [x] Split the current action into three clear steps: choose/change CSV,
      preflight data, and import. Do not add an “as new / historical” toggle.
- [x] Disable preflight until a file is selected. Disable import until the
      currently selected file has completed preflight successfully, and disable
      all conflicting actions while preflight submission, import submission, or
      the import background task is running.
- [x] Reset the successful preflight state whenever another file is selected so
      a different file can never inherit an unlocked Import button.
- [x] Add an API function and response resolver that reads the count headers and
      CSV bytes, while continuing to route HTTP failures through
      `formatErrorForShowErrorWithDetails`.
- [x] When any records are skipped, automatically download the returned CSV and
      show one Ukrainian warning with separate missing-timestamp and
      invalid-size counts, the total message count, and confirmation that all
      skipped examples were downloaded.
- [x] When no timestamps are missing, show a successful preflight status, do not
      download a file, and unlock Import.
- [x] On Import, upload the same selected browser `File`, pass
      `isHistorical = true`, launch the existing background-task console, and
      prevent duplicate submissions while the launch request is pending.
- [x] Update the explanatory page copy to state that import is historical,
      timestamps come from message bodies, and records without a parseable
      timestamp are skipped.

### 5. Automated coverage

- [x] Unit-test shared CSV loading with quoted multiline messages, commas,
      CRLF, empty records, malformed row shapes, and round-tripping the failed
      messages into a valid one-column CSV.
- [x] Unit-test timestamp extraction with both documented CSV examples, all
      production-supported timestamp layouts relevant to imports, a missing
      timestamp, an invalid timestamp, date-only input, Kyiv winter/summer UTC
      conversion, and a fixed reference time for partial dates.
- [x] Endpoint-test preflight counts, failed-only CSV content/order, safe
      download headers, the zero-failure response, malformed CSV rejection,
      multipart limits, and write-role authorization.
- [x] Add a database-backed historical import regression proving that a valid
      row has equal `signal_message.created_at` and
      `signal_message.timestamp`, the expected `sigint_inbox_item.datetime`, a
      historical message UID, and no recent Duty ordering timestamp.
- [x] Add a mixed-file regression proving that invalid rows create no database
      or fanout/search artifacts, valid rows still import, and task logs contain
      per-row warnings plus accurate totals.
- [x] Add an oversized/multi-message regression proving such a CSV record is
      detected during preflight and creates no signal or inbox records during
      import.
- [x] Preserve a regression for `isHistorical = false` so the compatibility
      path still uses current insertion time.
- [x] Add browser coverage for the locked Import button, successful preflight,
      automatic failed-example download and warning, re-locking after file
      replacement, error handling, and the outgoing `isHistorical=true` import
      request.

### 6. Validation and delivery

- [x] Run targeted Rust unit/functional tests for the parser, endpoint, import,
      authorization, and split-message behavior.
- [x] Run `cargo fmt`, `cargo check`, and `cargo clippy` without unrelated
      formatting changes.
- [x] Compile the changed Elm page directly with `elm make`, then run
      `just build-front` and the relevant frontend/E2E regression.
- [x] Since TypeScript E2E coverage was added, run
      `cd wdintel-web && npm run format:staged` and its targeted test.
- [x] Add a `CHANGELOG.md` NEXT entry linked to
      [#3650](https://github.com/echoua/echo/issues/3650), following the
      repository's NEXT formatting and phrasing conventions.
