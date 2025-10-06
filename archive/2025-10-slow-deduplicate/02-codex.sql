  WITH filtered AS (
      SELECT
          sm.id,
          sm.body,
          sm.message_uid,
          sm."timestamp",
          sm.sender,
          sm.datasource_group_id,
          sii.freq,
          sii.coords,
          sii.callsigns,
          sii.callsigns_alg2,
          sii.callsign_tokens,
          sii.signal_tokens,
          sii.keyword_tokens,
          sii.location_v2,
          sii.date,
          sii.time,
          sii.checked,
          sii.unit_v2,
          sii.post_id,
          sii.datetime,
          sii.tags,
          COALESCE(sm.duplicate_of, sm.id)        AS dedup_key,
          (sm.duplicate_of IS NULL)               AS prefer_original,
          ROW_NUMBER() OVER (
              PARTITION BY COALESCE(sm.duplicate_of, sm.id)
              ORDER BY (sm.duplicate_of IS NULL) DESC,
                       sii.datetime DESC,
                       sm.id DESC
          ) AS rn
      FROM sigint_inbox_item   AS sii
      JOIN signal_message      AS sm  ON sm.id = sii.id
      WHERE sm.deleted = FALSE
        AND sm.datasource_group_id = ANY (:group_ids)      -- pre-resolve IDs once
        AND sii.datetime BETWEEN :from_utc AND :to_utc
        AND (
              sii.callsigns ? 'малой'
           OR sii.callsigns ? 'север'
        )
  ),
  chosen AS (
      SELECT *
      FROM filtered
      WHERE rn = 1
      ORDER BY datetime DESC, id DESC
      LIMIT 20
  )
  SELECT
      c.body,
      c.message_uid,
      c."timestamp",
      dg.group_master_key,
      c.sender,
      dg.datasource_id,
      c.freq,
      c.coords,
      c.callsigns,
      c.callsigns_alg2,
      c.callsign_tokens,
      c.signal_tokens,
      c.keyword_tokens,
      c.location_v2,
      c.date,
      c.time,
      c.checked,
      c.unit_v2,
      c.post_id,
      c.datetime,
      sp.name AS post_name,
      c.tags
  FROM chosen AS c
  LEFT JOIN datasource_group AS dg ON dg.id = c.datasource_group_id
  LEFT JOIN signal_group     AS sg ON sg.master_key = dg.group_master_key
  LEFT JOIN sigint_post      AS sp ON sp.id = c.post_id
  ORDER BY c.datetime DESC, c.id DESC;
