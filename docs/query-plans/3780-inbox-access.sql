\set ON_ERROR_STOP on

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '500ms';
SET LOCAL plan_cache_mode = force_custom_plan;

PREPARE inbox_access(text[], timestamp, timestamp) AS
SELECT COUNT(*) AS count,
       MIN(signal_message.timestamp) AS first_element_ts
FROM sigint_inbox_item
INNER JOIN LATERAL (
    SELECT signal_message.id, signal_message.timestamp,
           signal_message.created_at, signal_message.deleted,
           signal_message.datasource_group_id, signal_message.message_uid
    FROM signal_message
    WHERE signal_message.id = sigint_inbox_item.id
      AND signal_message.deleted = FALSE
    OFFSET 0
) AS signal_message ON TRUE
WHERE signal_message.deleted = FALSE
\if :message_first
  AND EXISTS (
      SELECT 1
      FROM (
          SELECT signal_message_group.group_master_key
          FROM signal_message_group
          WHERE signal_message_group.signal_message_id = signal_message.id
          OFFSET 0
      ) AS access_groups
      WHERE access_groups.group_master_key = ANY($1)
  )
\else
  AND EXISTS (
      SELECT 1
      FROM signal_message_group
      WHERE signal_message_group.signal_message_id = signal_message.id
        AND signal_message_group.group_master_key = ANY($1)
      OFFSET 0
  )
\endif
  AND datetime >= $2
  AND datetime <= $3
  AND datetime >= ($2 AT TIME ZONE 'UTC')
  AND datetime <= ($3 AT TIME ZONE 'UTC');

EXPLAIN (VERBOSE, FORMAT JSON)
EXECUTE inbox_access(:'allowed_groups'::text[], :'since'::timestamp, :'till'::timestamp);

EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON, FORMAT JSON)
EXECUTE inbox_access(:'allowed_groups'::text[], :'since'::timestamp, :'till'::timestamp);

ROLLBACK;
