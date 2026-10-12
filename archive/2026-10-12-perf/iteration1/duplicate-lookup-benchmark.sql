\set ON_ERROR_STOP on

DO $$
BEGIN
    IF NOT starts_with(current_database(), 'wd_test_3780_index_benchmark') THEN
        RAISE EXCEPTION 'Use a fresh isolated wd_test_3780_index_benchmark database';
    END IF;
END
$$;

SET statement_timeout = '15min';

CREATE UNLOGGED TABLE signal_message_group (
    id bigint NOT NULL,
    signal_message_id bigint NOT NULL,
    signal_message_uuid uuid,
    group_master_key text,
    sender text,
    login_id uuid,
    message_uid text,
    datasource_group_id bigint,
    created_at timestamp NOT NULL
);

INSERT INTO signal_message_group
SELECT n, n % 35262078, NULL,
       'bench-group-' || (n % 1280),
       CASE WHEN n % 7 = 0 THEN NULL ELSE md5((n % 997)::text) END,
       NULL, 'bench-message-' || n, n % 1000,
       timestamp '2026-01-01' + (n / 1000) * interval '1 second'
FROM generate_series(1::bigint, 38774958::bigint) AS n;

ANALYZE signal_message_group;
SELECT pg_size_pretty(pg_relation_size('signal_message_group')) AS heap_size;

SET statement_timeout = '10s';
EXPLAIN
SELECT id, signal_message_id FROM signal_message_group
WHERE signal_message_id <> 0 AND datasource_group_id = 777
  AND created_at = timestamp '2026-01-01' + interval '19388 seconds'
  AND sender = md5((19388777 % 997)::text);

EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)
SELECT id, signal_message_id FROM signal_message_group
WHERE signal_message_id <> 0 AND datasource_group_id = 777
  AND created_at = timestamp '2026-01-01' + interval '19388 seconds'
  AND sender = md5((19388777 % 997)::text);

SET statement_timeout = '15min';
CREATE INDEX CONCURRENTLY signal_message_group_duplicate_lookup_idx
    ON signal_message_group (datasource_group_id, created_at, sender)
    INCLUDE (id, signal_message_id);
ANALYZE signal_message_group;

SET statement_timeout = '10s';
EXPLAIN
SELECT id, signal_message_id FROM signal_message_group
WHERE signal_message_id <> 0 AND datasource_group_id = 777
  AND created_at = timestamp '2026-01-01' + interval '19388 seconds'
  AND sender = md5((19388777 % 997)::text);

EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)
SELECT id, signal_message_id FROM signal_message_group
WHERE signal_message_id <> 0 AND datasource_group_id = 777
  AND created_at = timestamp '2026-01-01' + interval '19388 seconds'
  AND sender = md5((19388777 % 997)::text);

EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON)
SELECT id, signal_message_id FROM signal_message_group
WHERE signal_message_id <> 0 AND datasource_group_id = 775
  AND created_at = timestamp '2026-01-01' + interval '19388 seconds'
  AND sender IS NULL;

SELECT pg_size_pretty(pg_relation_size(
    'signal_message_group_duplicate_lookup_idx'
)) AS index_size;
