explain analyse
select
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
	"sigint_inbox_item"."tags" as "tags"
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
	"sigint_inbox_item"."datetime" desc,
	"signal_message"."id" desc
limit
	20 -- ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------->
	--  Limit  (cost=105.70..2187.51 rows=20 width=1069) (actual time=6.629..6.632 rows=20 loops=1)
	--    ->  Incremental Sort  (cost=105.70..152910.43 rows=1468 width=1069) (actual time=6.627..6.629 rows=20 loops=1)
	--          Sort Key: sigint_inbox_item.datetime DESC, signal_message.id DESC
	--          Presorted Key: sigint_inbox_item.datetime
	--          Full-sort Groups: 1  Sort Method: quicksort  Average Memory: 67kB  Peak Memory: 67kB
	--          ->  Nested Loop Left Join  (cost=1.57..152844.37 rows=1468 width=1069) (actual time=0.473..5.851 rows=22 loops=1)
	--                ->  Nested Loop  (cost=1.30..152398.23 rows=1468 width=1061) (actual time=0.466..5.802 rows=22 loops=1)
	--                      ->  Nested Loop  (cost=0.86..152163.22 rows=2010 width=1031) (actual time=0.433..5.626 rows=22 loops=1)
	--                            ->  Index Scan Backward using sigint_inbox_item_datetime_idx on sigint_inbox_item  (cost=0.43..135823.75 rows=2010 width=487) (actual time=0.395..5.385 rows=22 loops=1)
	--                                  Index Cond: ((datetime >= '2025-09-23 21:00:00+00'::timestamp with time zone) AND (datetime <= '2025-10-01 21:00:00'::timestamp without time zone))
	--                                  Filter: ((callsigns ? 'малой'::text) OR (callsigns ? 'север'::text))
	--                                  Rows Removed by Filter: 3251
	--                            ->  Index Scan using signal_message_pkey on signal_message  (cost=0.43..8.13 rows=1 width=552) (actual time=0.010..0.010 rows=1 loops=22)
	--                                  Index Cond: (id = sigint_inbox_item.id)
	--                                  Filter: (NOT deleted)
	--                      ->  Memoize  (cost=0.44..0.91 rows=1 width=46) (actual time=0.007..0.007 rows=1 loops=22)
	--                            Cache Key: signal_message.datasource_group_id
	--                            Cache Mode: logical
	--                            Hits: 7  Misses: 15  Evictions: 0  Overflows: 0  Memory Usage: 3kB
	--                            ->  Index Scan using datasource_group_pkey on datasource_group  (cost=0.43..0.90 rows=1 width=46) (actual time=0.009..0.009 rows=1 loops=15)
	--                                  Index Cond: (id = signal_message.datasource_group_id)
	--                                  Filter: (group_master_key = ANY ('{120363403704773705@g.us,120363194939199979@g.us,120363197516314187@g.us,120363184642482442@g.us,120363198889367752@g.us,120363203554892350@g.us,120363176653128009@g.us,12036>
	--                ->  Index Scan using sigint_post_pkey on sigint_post  (cost=0.27..0.30 rows=1 width=16) (actual time=0.001..0.001 rows=0 loops=22)
	--                      Index Cond: (id = sigint_inbox_item.post_id)
	--  Planning Time: 9.488 ms
	--  Execution Time: 6.853 ms
	-- (26 rows)