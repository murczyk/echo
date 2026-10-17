-- Experimental SELECT only; $1 = frequency IDs, $2 = fixed UTC upper horizon.
-- Inspect EXPLAIN first and use a bounded read-only session. See investigation.md.
WITH target AS MATERIALIZED (
    SELECT id, network_id, freq, active_from, active_to
    FROM sigint_network_freq
    WHERE id = ANY($1::bigint[]) AND NOT deleted
)
SELECT target.id,
       (
           SELECT MAX(dt)
           FROM (
               (
                   SELECT ii.datetime AS dt
                   FROM sigint_inbox_item ii
                   JOIN signal_message sm ON sm.id = ii.id AND NOT sm.deleted
                   WHERE network.id IS NOT NULL
                     AND ii.freq = target.freq
                     AND EXISTS (
                         SELECT 1 FROM sigint_inbox_item_network iin
                         WHERE iin.sigint_network_id = target.network_id
                           AND iin.sigint_inbox_item_id = ii.id
                     )
                     AND ii.datetime IS NOT NULL
                     AND ii.datetime >= target.active_from
                     AND ii.datetime <= COALESCE(target.active_to, $2::timestamp)
                     AND ii.datetime >= COALESCE(network.active_from, '-infinity'::timestamp)
                     AND ii.datetime <= COALESCE(network.active_to, $2::timestamp)
                   ORDER BY ii.datetime DESC
                   LIMIT 1
               )
               UNION ALL
               (
                   SELECT MAX(sm.timestamp) AS dt
                   FROM sigint_inbox_item ii
                   JOIN signal_message sm ON sm.id = ii.id AND NOT sm.deleted
                   WHERE network.id IS NOT NULL
                     AND ii.freq = target.freq
                     AND EXISTS (
                         SELECT 1 FROM sigint_inbox_item_network iin
                         WHERE iin.sigint_network_id = target.network_id
                           AND iin.sigint_inbox_item_id = ii.id
                     )
                     AND ii.datetime IS NULL
                     AND sm.timestamp IS NOT NULL
                     AND sm.timestamp >= target.active_from
                     AND sm.timestamp <= COALESCE(target.active_to, $2::timestamp)
                     AND sm.timestamp >= COALESCE(network.active_from, '-infinity'::timestamp)
                     AND sm.timestamp <= COALESCE(network.active_to, $2::timestamp)
               )
               UNION ALL
               (
                   SELECT MAX(sm.created_at) AS dt
                   FROM sigint_inbox_item ii
                   JOIN signal_message sm ON sm.id = ii.id AND NOT sm.deleted
                   WHERE network.id IS NOT NULL
                     AND ii.freq = target.freq
                     AND EXISTS (
                         SELECT 1 FROM sigint_inbox_item_network iin
                         WHERE iin.sigint_network_id = target.network_id
                           AND iin.sigint_inbox_item_id = ii.id
                     )
                     AND ii.datetime IS NULL
                     AND sm.timestamp IS NULL
                     AND sm.created_at >= target.active_from
                     AND sm.created_at <= COALESCE(target.active_to, $2::timestamp)
                     AND sm.created_at >= COALESCE(network.active_from, '-infinity'::timestamp)
                     AND sm.created_at <= COALESCE(network.active_to, $2::timestamp)
               )
           ) matches
       ) AS last_seen_dt
FROM target
LEFT JOIN sigint_network network
  ON network.id = target.network_id AND NOT network.deleted
ORDER BY target.id;
