INSTALL postgres;
LOAD postgres;
CREATE OR REPLACE TEMPORARY SECRET postgres_local (
    TYPE postgres,
    HOST '127.0.0.1',
    DATABASE postgres,
    USER 'wd',
    PASSWORD 'fee_-_-_-FnoeKFBeebu87bf'
);
ATTACH OR REPLACE 'dbname=wd' AS wd (TYPE postgres, SECRET postgres_local);

set variable pg_inbox_query = $$
with label_tags as materialized (
    select label_id
         , array_agg(tag.id) filter (where tag.id is not null) as label_tags
    from (values (0, 'переміщення'),
        (1, 'бпла'),
        (2, 'звʼязок'),
        (3, 'забезп'),
        (4, 'арта'),
        (4, 'ураження'),
        (5, 'втрати'),
        (5, 'евакуація'),
        (6, 'іфо'),
        (6, 'позиції'),
        (7, 'палітра'),
        (7, 'прив''язка'),
        (8, 'мораль'),
        (9, 'зіткнення'),
        (9, 'штурм'),
        (9, 'шд')
    ) as label(label_id, label_text)
    left join tag on tag.label = label.label_text
    group by label_id
), cte as (
    select x.id
        , x.created_at
        , x."datetime"
        , x.tags
        , coalesce(l.labels, array[]::int[]) as labels
        , coalesce(nullif(regexp_replace(x.body, '^[^—]*—\s*', ''), ''), x.body) as text
        , l.labels_binary
    from (
        select  i.id
            , m.created_at
            , i."datetime"
            , i.body_noheader->>'body' as body
            , coalesce(t.tags, array[]::bigint[]) as tags
        from sigint_inbox_item i
        left join lateral (
            select array_agg(j.tag_id::bigint) as tags from jsonb_array_elements(i.tags) as j(tag_id)
        ) as t on true
        join signal_message m on m.id = i.id
        where i.body_noheader is not null
          and i.tags is not null
          and jsonb_array_length(i.tags) > 0
        ) as x
    left join lateral (
        select array_agg(lt.label_tags && x.tags order by lt.label_id) as labels_binary
             , array_agg(lt.label_id) filter (where lt.label_tags && x.tags) as labels
        from label_tags lt
        ) as l on true
    where x.body is not null
      and x.body <> ''
)
select c.id as "__id"
    , c.created_at AT TIME ZONE 'UTC' as "__created_at"
    , c."datetime" AT TIME ZONE 'UTC' as "__datetime"
    , c.tags as "__tags"
    , c.labels as "__labels"
    , c.labels_binary[1] as label_0
    , c.labels_binary[2] as label_1
    , c.labels_binary[3] as label_2
    , c.labels_binary[4] as label_3
    , c.labels_binary[5] as label_4
    , c.labels_binary[6] as label_5
    , c.labels_binary[7] as label_6
    , c.labels_binary[8] as label_7
    , c.labels_binary[9] as label_8
    , c.labels_binary[10] as label_9
    , lower(c.text collate "ru-x-icu") as "text"
from cte c
$$;

copy (
    select 'wd' as "__source", * from postgres_query('wd', getvariable('pg_inbox_query'))
)
to 'echo-wd.parquet' (compression 'zstd');
