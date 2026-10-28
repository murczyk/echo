# Callsign reconciliation

The #3888 parser correction applies to newly parsed messages. Existing stored
callsigns and highlights need an explicitly approved reprocessing run.

## Scope and approval

Before changing staging or production, obtain approval naming the server,
operation, exact UTC range, and parser mode. Deployment approval does not by
itself authorize reconciliation. The commands below are procedures, not approval.

`oneoff-reprocess-callsigns` processes **all groups** in the range, not only
aviation groups. It selects inbox items by their stored interception `datetime`,
with `start <= datetime < end`, excluding reviewed and deleted messages.
Both `reviewed = false` and `reviewed IS NULL` are eligible. Messages without a
stored datetime or body are not repaired by this command. Reviewed messages
require a separately approved manual correction.

The command uses the configured AI callsign worker when enabled, merging its
result with template parsing. Without an enabled worker it uses regular parsing.
Confirm the worker configuration before approving the run; the startup banner
prints the parser and AI engine. The TUI command starts processing immediately,
so it is not a read-only preview. Its `a` key changes the parser for later items;
do not change modes outside the approved scope.

## Approved run

1. Confirm the affected messages' stored UTC datetimes and existing callsigns,
   highlights, manual overrides, and network links using read-only queries.
   Retain that snapshot for comparison and any separately approved recovery.
2. Bound the initial run to a small agreed interval. Each hour is loaded into
   memory and messages are parsed individually, including NLP and potentially
   AI requests. Check the selection query plan against representative data with
   a defensive statement timeout as described in [QUERY_PERF.md](../QUERY_PERF.md).
   Record the selected count and expected load before approval.
3. After approval, run the installed corrected binary on the named server:

   ```bash
   wdintel-rs --mode=live oneoff-reprocess-callsigns \
     --start 2026-10-19T00:00:00 --end 2026-10-19T01:00:00
   ```

   Replace the example timestamps with the approved range. Save the startup
   banner, progress output, and errors. Do not change worker settings simply to
   choose a parser without approval for that configuration change.
4. Verify corrected primary callsigns and highlights on affected samples,
   including postless headers, two-digit lists with trailing commas, compound
   names, all supported network-color markers, and LF/CRLF input. Confirm that
   flight data after the header was not added as a callsign, and manual overrides
   and secondary (`alg2`) callsigns were retained and highlighted.
5. Verify inferred network and unit links and allow the normal background worker
   to drain the queued group-stat recalculations. Reopen affected Duty/Analysis
   views; this oneoff does not broadcast a browser update event.

## Failure, resumption, and analytics

Each message commits atomically. If parsing fails, or a message's body, review
status, datetime, callsigns, or applicable feedback changes before saving, the
command stops without committing that message. Earlier messages remain committed.
Record the state and obtain approval for recovery outside the original scope.
Within an approval that permits retries, the same bounded interval can be rerun;
regular parsing is deterministic and unchanged callsigns/highlights avoid writes.
AI output may change on a rerun, so inspect its before/after results again.

Changed primary callsigns refresh inferred network/unit relations and enqueue
statistics in the same transaction. Manual additions/removals are reapplied,
secondary callsigns are preserved, and concurrent edits cannot be silently
overwritten. A rerun with unchanged primary callsigns does not recalculate networks
or enqueue statistics again.

There is no schema migration or resnapshot requirement. On deployments with
analytics, row changes propagate through normal CDC; wait for replication to catch
up and compare the corrected PostgreSQL values with the current-state analytics
views before accepting analytical results. Use existing monitoring for freshness;
health commands that write heartbeat metadata require approval too. Do not use a
full mirror resync to apply this parser correction.
