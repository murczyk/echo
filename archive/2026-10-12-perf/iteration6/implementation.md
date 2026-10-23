# Pivnich query fixes after iteration 6 (#3780)

Local implementation on `3780-pivnich-followup`, branched from `main` at
`6029bcad1`. Production findings and diagnostic limits are recorded in
[findings.md](findings.md). No deployment or remote configuration/data change
has been performed.

## Unit-filtered source counts

The source digest path without a supported explicit interception-time period
now materializes matching network-ID sets once at the outer statement level.
Selected, denied and undefined-unit predicates share the existing hierarchy
and active-network/frequency rules. The CTEs belong to the count statement;
there is no cross-request cache or additional database snapshot.

Ordinary header-unit matching and direct inbox-unit IDs retain their existing
OR relationship. Denied direct-unit IDs remain an independent exclusion.
Cursor ordering, authorization, deletion, ignored source groups and fresh-tail
creation bounds remain in the normal query builder. The existing explicit
period strategy is retained. No index, migration or pool/deadline change is
required.

The database regression extends the existing child-unit fixture to compare
ordinary and correlated digest results with the production map selector for
creation/timestamp cursors, exact and descendant matching, undefined units,
denied units and direct linked-unit IDs.

## Analytics Fuzzy search

Search construction now carries the analytics scope independently of message
correlation. Native analytics queries inline the tsquery expression; source
correlated reads retain their scalar parse-once subquery. Both paths keep the
same prefix, conjunction, OR, negation, filename and attachment predicates.
Quoted/Exact/Substring routing and attachment freshness guards are unchanged.

The existing mixed-source attachment regression compares inline analytics,
correlated source and ordinary source expressions, including stop words,
numeric tokens, negative terms and cross-attachment matches. Analytics pools
retain their existing custom-plan setting; generic prepared plans are not
assumed to have equivalent pushdown.

## Tagged posts facets

Posts detail and count builders now use source-resolved tag ownership and
unit-login access for analytics requests, following the sender breakdown
path. The shared resolver is used only when tag filters or unit restrictions
need it. Source posts queries retain their existing direct authorization path.

Resolution preserves the requested tag count, duplicate association-row
semantics, confidence/model restrictions, selected and denied tags, and
unit-only access. The posts facet still removes its own post filter. Permission
resolution does not turn an inaccessible requested tag into a smaller query.

The existing tag-authorization regression now also compares posts results
with unresolved and resolved access for public, owned and inaccessible tags,
duplicate associations, model exclusions and bounded/unbounded scopes.

## Validation and release

Local database checks used `wd_test_3780_pivnich_followup` and
`wd_files_test_3780_pivnich_followup`. The source was restored from the standard
test dump; the separate file registry database used the normal test migrations.

| Check | Result |
| --- | --- |
| `cargo fmt --all -- --check` | Passed |
| `cargo check -p wdintel-rs --all-targets --all-features` | Passed |
| `cargo clippy -p wdintel-rs --all-targets --all-features -- -D warnings` | Passed |
| `cargo test -p wdintel-rs --bin wdintel-rs 3780 -- --test-threads=1` | 22 passed; one existing ignored test |
| Existing child-unit regression, extended with materialized digest/map comparisons | Passed |
| Existing analytics tag-count regression, extended with posts ownership and duplicate-row comparisons | Passed |
| `analytics_pool_forces_custom_query_plans` | Passed |
| `just build-front` | Passed |
| Whitespace and archive-link checks | Passed |

The three additional regressions ran together through the compiled test
harness with the same dedicated database environment. Prepared gateway
`EXPLAIN` reproduced native Fuzzy/prefix filtering under `force_custom_plan`;
a forced generic plan retained local filtering. No persistent setting changed.
Production diagnostic timings in the findings are not application latency
guarantees, and no post-deployment performance improvement is claimed.

This batch needs only the normal backend package rollout, after explicit
approval naming the operation and target. No analytics reconciliation,
attachment history copy, schema migration or resource-profile activation is
needed for these query changes. For a canary, compare useful completions,
whole-request tails, source cancellations/block work and native memory over
matched peak windows. Include unit-filtered Duty counts, broad Fuzzy searches,
and tagged posts with AOR/location/metadata combinations and nonempty results.
Keep per-query diagnostic limits when inspecting plans; do not replay the
original memory-exhausting shape without bounds.

Rollback consists of reverting the backend through the normal approved
deployment process. There is no new schema or persisted configuration to undo.
