-- pick one representative id per dedup_key under your filters
explain analyse
SELECT
  sm.id,
  sm.body,
  sm.message_uid,
  sm."timestamp",
  dg.group_master_key,
  sm.sender,
  dg.datasource_id,
  sii.freq,
  sii.coords,
  sii.callsigns,
  sii.callsigns_alg2,
  sii.callsign_tokens,
  sii.signal_tokens,
  sii.keyword_tokens,
  sii.location_v2,
  sii."date",
  sii."time",
  sii.checked,
  sii.unit_v2,
  sii.post_id,
  sii."datetime",
  sp.name AS post_name,
  sii.tags
FROM
  (
    SELECT
      COALESCE(sm.duplicate_of, sm.id) AS dedup_key,
      MAX(sm.id) AS rep_id
    FROM
      signal_message sm
      JOIN sigint_inbox_item sii ON sii.id = sm.id
      JOIN datasource_group dg ON dg.id = sm.datasource_group_id -- (signal_group join isn't needed for filtering; pull it later if you need columns)
    WHERE
      sm.deleted = FALSE
      AND dg.group_master_key IN (
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
      AND (
        (sii.callsigns ? 'малой')
        OR (sii.callsigns ? 'север')
      )
      AND sii."datetime" >= (
        '2025-09-23 21:00:00.000000000' :: timestamp AT TIME ZONE 'UTC'
      )
      AND sii."datetime" <= '2025-10-01 21:00:00.000000'
    GROUP BY
      COALESCE(sm.duplicate_of, sm.id)
  ) pick
  JOIN signal_message sm ON sm.id = pick.rep_id
  LEFT JOIN sigint_inbox_item sii ON sii.id = sm.id
  LEFT JOIN datasource_group dg ON dg.id = sm.datasource_group_id
  LEFT JOIN sigint_post sp ON sp.id = sii.post_id -- (LEFT JOIN signal_group sg ON dg.group_master_key = sg.master_key) -- add if you need sg columns
ORDER BY
  sii."datetime" DESC,
  sm.id DESC
LIMIT
  20;

-- ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------->
--  Limit  (cost=157708.85..157708.90 rows=20 width=1069) (actual time=1013.277..1013.422 rows=20 loops=1)
--    ->  Sort  (cost=157708.85..157712.52 rows=1471 width=1069) (actual time=976.822..976.964 rows=20 loops=1)
--          Sort Key: sii.datetime DESC, sm.id DESC
--          Sort Method: top-N heapsort  Memory: 102kB
--          ->  Nested Loop Left Join  (cost=141034.24..157669.70 rows=1471 width=1069) (actual time=805.948..974.820 rows=1229 loops=1)
--                ->  Nested Loop Left Join  (cost=141033.97..157243.12 rows=1471 width=1061) (actual time=805.933..973.129 rows=1229 loops=1)
--                      ->  Nested Loop Left Join  (cost=141033.54..154169.75 rows=1468 width=582) (actual time=804.360..877.136 rows=1229 loops=1)
--                            ->  Nested Loop  (cost=141033.39..153277.36 rows=1468 width=552) (actual time=804.221..873.700 rows=1229 loops=1)
--                                  ->  Finalize GroupAggregate  (cost=141032.96..141205.75 rows=1468 width=16) (actual time=803.780..805.725 rows=1229 loops=1)
--                                        Group Key: (COALESCE(sm_1.duplicate_of, sm_1.id))
--                                        ->  Gather Merge  (cost=141032.96..141184.95 rows=1224 width=16) (actual time=803.752..804.810 rows=1229 loops=1)
--                                              Workers Planned: 2
--                                              Workers Launched: 2
--                                              ->  Partial GroupAggregate  (cost=140032.94..140043.65 rows=612 width=16) (actual time=776.628..776.953 rows=410 loops=3)
--                                                    Group Key: (COALESCE(sm_1.duplicate_of, sm_1.id))
--                                                    ->  Sort  (cost=140032.94..140034.47 rows=612 width=16) (actual time=776.585..776.675 rows=745 loops=3)
--                                                          Sort Key: (COALESCE(sm_1.duplicate_of, sm_1.id))
--                                                          Sort Method: quicksort  Memory: 57kB
--                                                          Worker 0:  Sort Method: quicksort  Memory: 61kB
--                                                          Worker 1:  Sort Method: quicksort  Memory: 61kB
--                                                          ->  Hash Join  (cost=17.58..140004.61 rows=612 width=16) (actual time=14.792..776.082 rows=745 loops=3)
--                                                                Hash Cond: (sm_1.datasource_group_id = dg_1.id)
--                                                                ->  Nested Loop  (cost=0.86..139985.66 rows=838 width=24) (actual time=14.518..775.317 rows=758 loops=3)
--                                                                      ->  Parallel Index Scan using sigint_inbox_item_datetime_idx on sigint_inbox_item sii_1  (cost=0.43..133173.48 rows=838 width=8) (actual time=14.182..720.110 rows=758 loops>
--                                                                            Index Cond: ((datetime >= '2025-09-23 21:00:00+00'::timestamp with time zone) AND (datetime <= '2025-10-01 21:00:00'::timestamp without time zone))
--                                                                            Filter: ((callsigns ? 'малой'::text) OR (callsigns ? 'север'::text))
--                                                                            Rows Removed by Filter: 99304
--                                                                      ->  Index Scan using signal_message_pkey on signal_message sm_1  (cost=0.43..8.13 rows=1 width=24) (actual time=0.072..0.072 rows=1 loops=2273)
--                                                                            Index Cond: (id = sii_1.id)
--                                                                            Filter: (NOT deleted)
--                                                                ->  Hash  (cost=13.91..13.91 rows=225 width=8) (actual time=0.234..0.251 rows=161 loops=3)
--                                                                      Buckets: 1024  Batches: 1  Memory Usage: 15kB
--                                                                      ->  Seq Scan on datasource_group dg_1  (cost=0.29..13.91 rows=225 width=8) (actual time=0.053..0.208 rows=161 loops=3)
--                                                                            Filter: (group_master_key = ANY ('{120363403704773705@g.us,120363194939199979@g.us,120363197516314187@g.us,120363184642482442@g.us,120363198889367752@g.us,12036320355>
--                                                                            Rows Removed by Filter: 147
--                                  ->  Index Scan using signal_message_pkey on signal_message sm  (cost=0.43..8.21 rows=1 width=552) (actual time=0.055..0.055 rows=1 loops=1229)
--                                        Index Cond: (id = (max(sm_1.id)))
--                            ->  Index Scan using datasource_group_pkey on datasource_group dg  (cost=0.15..0.61 rows=1 width=46) (actual time=0.002..0.002 rows=1 loops=1229)
--                                  Index Cond: (id = sm.datasource_group_id)
--                      ->  Index Scan using sigint_inbox_item_pkey on sigint_inbox_item sii  (cost=0.43..2.09 rows=1 width=487) (actual time=0.077..0.077 rows=1 loops=1229)
--                            Index Cond: (id = sm.id)
--                ->  Index Scan using sigint_post_pkey on sigint_post sp  (cost=0.27..0.29 rows=1 width=16) (actual time=0.001..0.001 rows=0 loops=1229)
--                      Index Cond: (id = sii.post_id)
--  Planning Time: 4.473 ms
--  JIT:
--    Functions: 105
--    Options: Inlining false, Optimization false, Expressions true, Deforming true
--    Timing: Generation 8.667 ms, Inlining 0.000 ms, Optimization 3.035 ms, Emission 71.881 ms, Total 83.583 ms
--  Execution Time: 1039.822 ms
-- (49 rows)