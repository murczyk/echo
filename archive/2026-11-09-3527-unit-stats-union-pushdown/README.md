# Duty unit-count UNION pushdown: reverted (2026-11-09)

Issue [#3527](https://github.com/echoua/echo/issues/3527). PR #4086 shipped in
`0.1.1-rc.202611090807`; its revert shipped in the following hotfix release.
This note records the mistake so that the Duty unit-count query is not merged
into one ClickHouse query again without the checks listed below.

## What happened

Pivnich logged bursts of
`inbox unit stats analytics query failed; retrying via PostgreSQL: pg_clickhouse: query was canceled`.
The Duty unit-count query (`render_inbox_unit_stats_query`) is a linked-units
aggregate `UNION ALL` an undefined-unit (`Не визначено`) aggregate. Its
undefined arm selects an untyped `0` and name literal, so the gateway runs the
two aggregates as separate, sequential Foreign Scans. Under load their sum
reached the gateway role's 25-second `statement_timeout`.

The main amplifier was a hidden browser tab running a frontend bundle from
before rc.202611071515. It re-sent the request every ~6 seconds while the
server kept running each abandoned 25-second query, so 3–4 overlapped. That
tab disappeared at 07:06 UTC and the cancellations stopped.

#4086 cast the undefined arm's constants to `bigint`/`text`. The whole UNION
then planned as a single Foreign Scan. One validation run on Pivnich's
heaviest scope succeeded in 15.2 seconds at 2.01 GiB, 91.5% of the 2.2-GiB
per-query memory limit. After the release reached Skhid:

- a 23-group scope exceeded the per-query limit (code 241) on every
  execution, although its sequential arms had peaked at 1.14 and 1.75 GiB;
- each failure fell back to PostgreSQL, whose source admission was already
  saturated, so users saw `Аналітична система перевантажена`, and
  `get-inbox-unit-stats` went from ~8 s to 14–16 s average with 60 s maxima
  and 5xx responses;
- the 37-group scope took ~8 s both ways, so the change bought no latency
  there. On Pivnich it was ~15 s against ~16 s sequential.

The rollout was paused before Pivnich, and the change was reverted.

## The mistake

- **Treated the immediate symptom as the cause.** The timeouts came from load
  (one stale tab's overlapping requests), not from sequential arms. Once the
  tab was gone the cancellations stopped, but the change still shipped.
- **Validated one scope on one host.** A single run at 91.5% of the memory
  limit was read as "fits", although other scopes and hosts had heavier arms.
- **Ignored that merging arms sums their peak memory.** Sequential scans each
  get their own per-query budget; one pushed-down UNION shares one budget.
- **Didn't compare sequential and merged latency on the same host.** The
  expected speedup was assumed, not measured.
- **Accepted a fast fallback as harmless.** `analytics_resource_limit` falls
  back to PostgreSQL immediately, but on a saturated source that fallback is
  exactly what users feel.

## Checks before changing analytics query shape

1. Find the real cause first: request cadence (GreptimeDB `activity_details`,
   `x-echo-tab-id`, `x-echo-client-asset`), concurrency, and timeline.
2. For every analytics host, take the per-scope (access-group set) p90/max
   `memory_usage` and duration of each current gateway query from
   `system.query_log`. The new shape must stay well under the per-query
   memory limit for the heaviest scope, not only for the one tested.
3. Measure old and new shapes on the same host for the same scope, and
   compare latency as well as memory.
4. Check the PostgreSQL fallback's capacity on each host before relying on
   any analytics failure falling back quickly.
5. Roll out with canaries, but compare `query_log` 241/735 counts and
   endpoint latency per host before and after each deploy, since canaries
   may lack the heavy scopes. Kharkiv2 had no Duty unit-count traffic, and
   Skhid was the first host to show the problem.

## Future work

- **Narrow the undefined arm** so a single pushed-down query fits the memory
  limit. Its `LEFT ANTI JOIN` builds a hash of every active unit link in the
  ID range (~1 GiB) before the access-group filter applies. Restricting that
  side to the scoped messages, or computing the undefined count as scoped
  messages minus scoped linked messages, should shrink it. Only then
  reconsider merging the arms, using the checks above. The guard test
  `undefined_unit_arm_stays_a_separate_gateway_query_3527` must be changed
  deliberately when that happens.
- **Reload stale frontend bundles.** The server already receives
  `x-echo-client-asset`; a tab running an old bundle can keep sending an
  obsolete request pattern for days.
- **Skhid source saturation.** `/api/rer/analysis/stats/units` routes to
  PostgreSQL by `query_policy` and returned 5xx with
  `Аналітична система перевантажена` at 09:40 UTC, before this release
  reached Skhid. It needs its own investigation.
- **pg_clickhouse set-operation pushdown** of coerced constant arms was
  considered and deferred. It would not have helped here, because the merged
  query is the problem.
