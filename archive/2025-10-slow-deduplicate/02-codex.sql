explain analyse WITH groups AS (
  SELECT
    id
  FROM
    datasource_group
  WHERE
    group_master_key IN (
      '120363403704773705@g.us',
      '120363194939199979@g.us',
      '120363197516314187@g.us',
      '120363184642482442@g.us',
      '120363198889367752@g.us',
      '120363203554892350@g.us',
      '120363176653128009@g.us',
      '120363418857290496@g.us',
      '120363194605503510@g.us',
      '120363193538786537@g.us',
      '120363194939199979@g.us',
      '120363176653128009@g.us',
      '120363402696538835@g.us',
      '120363320066239859@g.us',
      '120363194806689869@g.us',
      '120363323478595910@g.us',
      '120363277069967829@g.us',
      '120363278959957887@g.us',
      '120363257887267926@g.us',
      '120363374617792461@g.us',
      '120363372356997052@g.us',
      '120363419175205630@g.us',
      '120363418132032285@g.us',
      '120363402060632310@g.us',
      '120363372356997052@g.us',
      '120363402501102765@g.us',
      '120363403692500354@g.us',
      '120363176653128009@g.us',
      '120363368634369077@g.us',
      '120363176653128009@g.us',
      '120363278978940170@g.us',
      '120363194806689869@g.us',
      '120363402875601689@g.us',
      '120363404422103743@g.us',
      '120363404186077151@g.us',
      '120363194605503510@g.us',
      '120363193538786537@g.us',
      '120363197516314187@g.us',
      '120363374617792461@g.us',
      '120363374617792461@g.us',
      '120363421121179004@g.us',
      '120363419907122319@g.us',
      '120363323478595910@g.us',
      '120363402696538835@g.us',
      '120363374617792461@g.us',
      '120363261986166932@g.us',
      '120363368634369077@g.us',
      '120363404422103743@g.us',
      '120363374617792461@g.us',
      '120363194605503510@g.us',
      '120363402527768559@g.us',
      '120363194605503510@g.us',
      '120363419056289002@g.us',
      '120363403692500354@g.us',
      '120363403692500354@g.us',
      '120363419907122319@g.us',
      '120363419907122319@g.us',
      '120363194605503510@g.us',
      '120363402682040381@g.us',
      '120363176653128009@g.us',
      '120363176653128009@g.us',
      '120363194939199979@g.us',
      '120363347749010774@g.us',
      '120363294242956971@g.us',
      '120363278328245545@g.us',
      'group.cTYySllrWFYyQ1l2Q0pKL3UzRWhxYm03Tml3aXlkbkl3ZWFzWE9DcTBFUT0=',
      '120363402060632310@g.us',
      '120363364131521148@g.us',
      '120363400612734315@g.us',
      '120363403692500354@g.us',
      '120363148618801872@g.us',
      '120363404186077151@g.us',
      '120363404422103743@g.us',
      '120363402682040381@g.us',
      '120363419056289002@g.us',
      '120363323478595910@g.us',
      '120363203554892350@g.us',
      '120363198889367752@g.us',
      '120363193538786537@g.us',
      'group.ZTczUGUvRDdjelNpdnBDYlJocWRGTysvVzBrZU0xVXBYS2hUczhLeVViMD0=',
      '120363175673072763@g.us',
      '120363195751633984@g.us',
      '120363278852355962@g.us',
      '120363320066239859@g.us',
      'group.WjB5eFNvK0xLNElsYlhxMEUvMFJmZ1Vycm1XVlYwQ1Z5Y0sxTjZmaUpsST0=',
      '120363148618801872@g.us',
      '120363372356997052@g.us',
      '120363421626631832@g.us',
      '120363403850282166@g.us',
      '120363402875601689@g.us',
      '120363418857290496@g.us',
      '120363194806689869@g.us',
      '120363402527768559@g.us',
      '120363368634369077@g.us',
      '120363418132032285@g.us',
      'group.cTYySllrWFYyQ1l2Q0pKL3UzRWhxYm03Tml3aXlkbkl3ZWFzWE9DcTBFUT0=',
      '120363406209961050@g.us',
      '120363402501102765@g.us',
      '120363278978940170@g.us',
      '120363197516314187@g.us',
      '120363194605503510@g.us',
      'group.VTB0NWsvcGRwT282dE9GNGFnb215Q2VWZHhoVUl0UzBlaXM3YTYvc2hUaz0=',
      'group.ekNJdmRxN0hPbmlLOUpXY2k0d3RFZ1Q5b0tpbnZVTEZLejVhaEFoeW55MD0=',
      '120363418971394548@g.us',
      '120363198780891097@g.us',
      '120363416162642428@g.us',
      '120363294015343159@g.us',
      '120363194605503510@g.us',
      '120363419036439554@g.us',
      '120363184642482442@g.us',
      '120363399243720769@g.us',
      '120363278959957887@g.us',
      '120363277069967829@g.us',
      '120363402696538835@g.us'
    )
),
filtered AS (
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
    COALESCE(sm.duplicate_of, sm.id) AS dedup_key,
    (sm.duplicate_of IS NULL) AS prefer_original,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(sm.duplicate_of, sm.id)
      ORDER BY
        (sm.duplicate_of IS NULL) DESC,
        sii.datetime DESC,
        sm.id DESC
    ) AS rn
  FROM
    sigint_inbox_item AS sii
    JOIN signal_message AS sm ON sm.id = sii.id
    JOIN groups AS g ON g.id = sm.datasource_group_id
  WHERE
    sm.deleted = FALSE
    AND sii.datetime >= TIMESTAMP '2025-09-23 21:00:00+00'
    AND sii.datetime <= TIMESTAMP '2025-10-01 21:00:00'
    AND (
      sii.callsigns ? 'малой'
      OR sii.callsigns ? 'север'
    )
),
chosen AS (
  SELECT
    *
  FROM
    filtered
  WHERE
    rn = 1
  ORDER BY
    datetime DESC,
    id DESC
  LIMIT
    20
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
FROM
  chosen AS c
  LEFT JOIN datasource_group AS dg ON dg.id = c.datasource_group_id
  LEFT JOIN signal_group AS sg ON sg.master_key = dg.group_master_key
  LEFT JOIN sigint_post AS sp ON sp.id = c.post_id
ORDER BY
  c.datetime DESC,
  c.id DESC;