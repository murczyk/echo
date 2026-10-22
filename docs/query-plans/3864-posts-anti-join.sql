\set ON_ERROR_STOP on
\if :{?timeout_ms}
\else
\set timeout_ms 5000
\endif

BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = :'timeout_ms';
SET LOCAL lock_timeout = '500ms';
SET LOCAL plan_cache_mode = force_custom_plan;

PREPARE posts_scan(text[], timestamp, timestamp) AS
SELECT signal_message.id AS id,
       sigint_inbox_item.freq AS freq,
       sigint_inbox_item.unit_v2 AS unit,
       sigint_post.name AS post
FROM signal_message
LEFT JOIN sigint_inbox_item ON signal_message.id = sigint_inbox_item.id
LEFT JOIN datasource_group ON signal_message.datasource_group_id = datasource_group.id
LEFT JOIN signal_group ON datasource_group.group_master_key = signal_group.master_key
LEFT JOIN sigint_post ON sigint_inbox_item.post_id = sigint_post.id
LEFT JOIN device_name ON sigint_inbox_item.device_name_id = device_name.id
WHERE signal_message.deleted = FALSE
  AND EXISTS (
      SELECT 1 FROM signal_message_group
      WHERE signal_message_group.signal_message_id = signal_message.id
        AND signal_message_group.group_master_key = ANY($1)
  )
  AND EXISTS (
      SELECT 1 FROM signal_message_group
      WHERE signal_message_group.signal_message_id = signal_message.id
        AND signal_message_group.group_master_key = ANY($1)
  )
  AND sigint_inbox_item.datetime >= $2
  AND sigint_inbox_item.datetime <= $3
  AND sigint_inbox_item.datetime >= ($2 AT TIME ZONE 'UTC')
  AND sigint_inbox_item.datetime <= ($3 AT TIME ZONE 'UTC')
\if :anti_join
  AND NOT EXISTS (
      SELECT 1 FROM intel_product
      WHERE intel_product.intel_message_id = signal_message.id
        AND intel_product.relation_kind::text IN ('comment', 'report')
  )
\else
  AND signal_message.id NOT IN (
      SELECT intel_product.intel_message_id FROM intel_product
      WHERE intel_product.relation_kind::text IN ('comment', 'report')
  )
\endif
;

EXPLAIN (VERBOSE, SETTINGS)
EXECUTE posts_scan(:'allowed_groups'::text[], :'since'::timestamp, :'till'::timestamp);

EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON, VERBOSE, SETTINGS)
EXECUTE posts_scan(:'allowed_groups'::text[], :'since'::timestamp, :'till'::timestamp);

ROLLBACK;
