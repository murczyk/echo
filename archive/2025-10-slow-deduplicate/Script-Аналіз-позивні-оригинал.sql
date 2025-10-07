explain analyse with "inbox_items_cte" as (
	select
		distinct on ("dedup_key") "signal_message"."id" as "id",
		"signal_message"."body" as "body",
		"signal_message"."message_uid" as "message_uid",
		"signal_message"."timestamp" as "timestamp",
		"datasource_group"."group_master_key" as "group_master_key",
		"signal_message"."sender" as "sender",
		"datasource_group"."datasource_id" as "datasource_id",
		"sigint_inbox_item"."freq" as "freq",
		"sigint_inbox_item"."coords" as "coords",
		"sigint_inbox_item"."callsigns" as "callsigns",
		"sigint_inbox_item"."callsigns_alg2" as "callsigns_alg2",
		"sigint_inbox_item"."callsign_tokens" as "callsign_tokens",
		"sigint_inbox_item"."signal_tokens" as "signal_tokens",
		"sigint_inbox_item"."keyword_tokens" as "keyword_tokens",
		"sigint_inbox_item"."location_v2" as "location_v2",
		"sigint_inbox_item"."date" as "date",
		"sigint_inbox_item"."time" as "time",
		"sigint_inbox_item"."checked" as "checked",
		"sigint_inbox_item"."unit_v2" as "unit_v2",
		"sigint_inbox_item"."post_id" as "post_id",
		"sigint_inbox_item"."datetime" as "datetime",
		"sigint_post"."name" as "post_name",
		"sigint_inbox_item"."tags" as "tags",
		coalesce(
			"signal_message"."duplicate_of",
			"signal_message"."id"
		) as "dedup_key"
	from
		"signal_message"
		left join "sigint_inbox_item" on "signal_message"."id" = "sigint_inbox_item"."id"
		left join "datasource_group" on "signal_message"."datasource_group_id" = "datasource_group"."id"
		left join "signal_group" on "datasource_group"."group_master_key" = "signal_group"."master_key"
		left join "sigint_post" on "sigint_inbox_item"."post_id" = "sigint_post"."id"
	where
		"signal_message"."deleted" = false
		and "datasource_group"."group_master_key" in (
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
		and (
			(
				callsigns :: jsonb ? 'малой'
				or callsigns :: jsonb ? 'север'
			)
		)
		and "datetime" >= (
			'2025-09-23 21:00:00.000000000' :: timestamp at time zone 'UTC'
		)
		and "sigint_inbox_item"."datetime" <= '2025-10-01 21:00:00.000000'
	order by
		dedup_key asc,
		(signal_message.duplicate_of is null) desc,
		"sigint_inbox_item"."datetime" desc,
		"signal_message"."id" desc
)
select
	*
from
	"inbox_items_cte"
order by
	"datetime" desc,
	"id" desc
limit
	20 -- ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------->
	--  Limit  (cost=141270.35..141270.40 rows=20 width=1077) (actual time=1913.865..1931.870 rows=20 loops=1)
	--    ->  Sort  (cost=141270.35..141274.02 rows=1468 width=1077) (actual time=1859.339..1877.343 rows=20 loops=1)
	--          Sort Key: inbox_items_cte.datetime DESC, inbox_items_cte.id DESC
	--          Sort Method: top-N heapsort  Memory: 105kB
	--          ->  Subquery Scan on inbox_items_cte  (cost=141041.96..141231.29 rows=1468 width=1077) (actual time=1855.772..1876.196 rows=1229 loops=1)
	--                ->  Unique  (cost=141041.96..141216.61 rows=1468 width=1078) (actual time=1855.735..1875.776 rows=1229 loops=1)
	--                      ->  Gather Merge  (cost=141041.96..141212.94 rows=1468 width=1078) (actual time=1855.734..1875.436 rows=2235 loops=1)
	--                            Workers Planned: 2
	--                            Workers Launched: 2
	--                            ->  Sort  (cost=140041.94..140043.47 rows=612 width=1078) (actual time=1827.716..1827.814 rows=745 loops=3)
	--                                  Sort Key: (COALESCE(signal_message.duplicate_of, signal_message.id)), ((signal_message.duplicate_of IS NULL)) DESC, sigint_inbox_item.datetime DESC, signal_message.id DESC
	--                                  Sort Method: quicksort  Memory: 1581kB
	--                                  Worker 0:  Sort Method: quicksort  Memory: 1441kB
	--                                  Worker 1:  Sort Method: quicksort  Memory: 1666kB
	--                                  ->  Hash Left Join  (cost=27.64..140013.61 rows=612 width=1078) (actual time=24.073..1823.421 rows=745 loops=3)
	--                                        Hash Cond: (sigint_inbox_item.post_id = sigint_post.id)
	--                                        ->  Hash Join  (cost=17.58..140001.94 rows=612 width=1069) (actual time=23.939..1822.797 rows=745 loops=3)
	--                                              Hash Cond: (signal_message.datasource_group_id = datasource_group.id)
	--                                              ->  Nested Loop  (cost=0.86..139982.99 rows=838 width=1039) (actual time=23.557..1821.558 rows=758 loops=3)
	--                                                    ->  Parallel Index Scan using sigint_inbox_item_datetime_idx on sigint_inbox_item  (cost=0.43..133170.81 rows=838 width=487) (actual time=22.278..1602.211 rows=758 loops=3)
	--                                                          Index Cond: ((datetime >= '2025-09-23 21:00:00+00'::timestamp with time zone) AND (datetime <= '2025-10-01 21:00:00'::timestamp without time zone))
	--                                                          Filter: ((callsigns ? 'малой'::text) OR (callsigns ? 'север'::text))
	--                                                          Rows Removed by Filter: 99304
	--                                                    ->  Index Scan using signal_message_pkey on signal_message  (cost=0.43..8.13 rows=1 width=560) (actual time=0.287..0.287 rows=1 loops=2273)
	--                                                          Index Cond: (id = sigint_inbox_item.id)
	--                                                          Filter: (NOT deleted)
	--                                              ->  Hash  (cost=13.91..13.91 rows=225 width=46) (actual time=0.271..0.272 rows=161 loops=3)
	--                                                    Buckets: 1024  Batches: 1  Memory Usage: 20kB
	--                                                    ->  Seq Scan on datasource_group  (cost=0.29..13.91 rows=225 width=46) (actual time=0.059..0.233 rows=161 loops=3)
	--                                                          Filter: (group_master_key = ANY ('{120363403704773705@g.us,120363194939199979@g.us,120363197516314187@g.us,120363184642482442@g.us,120363198889367752@g.us,120363203554892350@g.us,12036>
	--                                                          Rows Removed by Filter: 147
	--                                        ->  Hash  (cost=6.14..6.14 rows=314 width=16) (actual time=0.122..0.122 rows=318 loops=3)
	--                                              Buckets: 1024  Batches: 1  Memory Usage: 25kB
	--                                              ->  Seq Scan on sigint_post  (cost=0.00..6.14 rows=314 width=16) (actual time=0.026..0.072 rows=318 loops=3)
	--  Planning Time: 14.597 ms
	--  JIT:
	--    Functions: 97
	--    Options: Inlining false, Optimization false, Expressions true, Deforming true
	--    Timing: Generation 8.474 ms, Inlining 0.000 ms, Optimization 4.816 ms, Emission 104.406 ms, Total 117.695 ms
	--  Execution Time: 2134.794 ms
	-- (40 rows)