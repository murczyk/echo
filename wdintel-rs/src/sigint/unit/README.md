# SIGINT unit hierarchy

Duty, Analysis and the Callsigns sidebar read the hierarchy through
`POST /api/sigint/units/hierarchy`. The endpoint uses two Redis keys:

- `sigint:unit-tree:v1`: the computed groups, unit membership and revision.
- `sigint:unit-tree:v1:dirty`: a boolean, defaulting to false when absent.

A missing tree or a dirty marker causes the next request to rebuild the whole
hierarchy from non-deleted units, including inactive units. Echelon fields remain
the source of truth; no tree is persisted in PostgreSQL. Virtual parents, empty
echelons and distinct regional paths retain their existing filter identities.

Rebuilds share a PostgreSQL advisory transaction lock. A dedicated Redis
connection watches both keys before reading the units, then publishes the tree
and clears the marker atomically. A concurrent invalidation aborts publication,
leaving the next caller to rebuild again.

Committed application writes invalidate the cache when publishing
`ETUnitChanged`, even with no connected sessions. Unit, Etalon and ORBIT import
and maintenance commands invalidate after completion, including failures that
may have committed part of a batch; dry-run commands do not invalidate.
Maintenance that changes units directly in SQL must also invalidate this cache.

Clients send their known revision; an unchanged hierarchy returns JSON `null`.
Message and callsign counts stay separate from the cached structure. Removing
the tree key is sufficient to force reconstruction on the next request.
