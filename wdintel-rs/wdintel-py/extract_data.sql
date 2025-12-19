copy (from postgres_query('wd_pivnich', $$
with cte as materialized (
    select label_id,
        array_agg(tag.id) as label_tags
    from tag
        join (
            values (0, 'переміщення'),
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
        ) as label(label_id, label_text) on tag.label = label.label_text
    group by label_id
),
results as (
    select id,
        "datetime",
        lower(coalesce(
          nullif(regexp_replace("text", '^[^—]*—\s*', ''), ''),
          "text"
        )) as "text",
        (
            select array_agg (cte.label_id) filter (where x.tags && cte.label_tags)
            from cte
        ) as labels
    from (
            select id,
                jsonb_extract_path_text(body_noheader, 'body') "text",
                "datetime" AT TIME ZONE 'UTC' as "datetime",
                case when tags is not null then
                  ARRAY(SELECT jsonb_array_elements_text(tags))::bigint[]
                else 
                  array[]::bigint[]
                end as tags
            from sigint_inbox_item
            where body_noheader is not null
              and tags is not null
              and jsonb_array_length(tags) > 0
        ) x
    where x."text" is not null
      and x."text" <> ''
)
select
    "text",
    coalesce(labels, array[]::int[]) as labels,
    'wd-echo-pivnich.hyakutake-chromatic.ts.net-2025-12-08-02-40-01.pgrestore' as "__source",
    id as "__id",
    "datetime" as "__datetime"
from results
where 1=1
   and "text" <> ''
   and array_length(labels, 1) > 0
   and 1=1
$$))
  to 'echo-wd_pivnich.parquet' (compression 'zstd');
