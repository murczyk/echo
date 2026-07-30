# GOI Knowledge Cleanup

Date: 2026-07-30

## Summary

Soft-deleted rows were physically removed from `public.knowledge` on:

| Host | Size before | Rows retained | Deleted rows after | Size after |
| --- | ---: | ---: | ---: | ---: |
| `goi-jf` | 97 GB | 6,089 | 0 | 9,672 kB |
| `goi-159ombr` | 18 GB | 5,661 | 0 | 9,272 kB |

In both databases, nearly every row had `deleted = true`. The table had no
referencing foreign keys or user triggers. Copying the small active set,
truncating the table, and restoring the active rows avoided deleting millions
of rows individually and reclaimed the table space immediately.

No safety-copy table or external export was created.

## Procedure

All application services that could access the `goi` database were stopped
before cleanup. The following SQL was run interactively as PostgreSQL
administrator:

```sql
BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '0';

LOCK TABLE public.knowledge IN ACCESS EXCLUSIVE MODE;

CREATE TEMP TABLE knowledge_keep
ON COMMIT DROP
AS
SELECT id, row, created_at, updated_at, deleted, dedupe_key
FROM public.knowledge
WHERE deleted IS NOT TRUE;

SELECT count(*) AS rows_to_keep
FROM knowledge_keep;

TRUNCATE TABLE public.knowledge;

INSERT INTO public.knowledge
    (id, row, created_at, updated_at, deleted, dedupe_key)
SELECT
    id, row, created_at, updated_at, deleted, dedupe_key
FROM knowledge_keep;

SELECT
    (SELECT count(*) FROM knowledge_keep) AS expected_rows,
    (SELECT count(*) FROM public.knowledge) AS restored_rows,
    (SELECT count(*) FROM public.knowledge WHERE deleted IS TRUE)
        AS deleted_remaining;
```

The transaction was committed only after `expected_rows = restored_rows` and
`deleted_remaining = 0`:

```sql
COMMIT;
ANALYZE public.knowledge;
```

If validation fails, use `ROLLBACK` instead of `COMMIT`.

## Host Notes

### `goi-jf`

- Stopped `goi.service` and `echo-swapp.service`.
- The preservation scan of the 59 GB heap took about 2 minutes 41 seconds.
- Restored and validated 6,089 rows before committing.
- Restarted both previously running services and verified they were active.

### `goi-159ombr`

- Stopped `goi.service`, `goi-echo-worker.service`, `echo-swapp.service`, the
  running Signal bot, and four running WhatsApp bot units.
- Service shutdown left a disconnected PostgreSQL backend executing the
  application's own `DELETE FROM knowledge` cleanup. Its client socket was
  already closed, so the backend query was cancelled with
  `pg_cancel_backend` before taking the table lock.
- The preservation scan of the 11 GB heap took about 12 seconds.
- Restored and validated 5,661 rows before committing.
- Restarted all eight previously running application units and verified they
  were active.

## Safety Notes

- The actual column name is `deleted`, not `delete`.
- Stop writers before taking the lock; otherwise the lock can block application
  traffic and concurrent changes can complicate operational validation.
- Keep the preservation, truncate, restore, and validation steps in one
  transaction. A disconnect or SQL error before `COMMIT` rolls them back.
- The existing `knowledge_id_seq`, indexes, grants, and table identity are
  preserved by truncating rather than replacing the table.
