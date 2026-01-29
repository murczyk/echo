from duckdb import DuckDBPyConnection

POSTGRES_INBOX_QUERY = r"""
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
        , coalesce(l.labels_binary, array[]::bool[]) as labels_binary
        , coalesce(nullif(regexp_replace(x.body, '^[^—]*—\s*', ''), ''), x.body) as text
    from (
        select  i.id
            , m.created_at
            , i."datetime"
            , i.body_noheader->>'body' as body
            , coalesce(t.tags, array[]::bigint[]) as tags
        from sigint_inbox_item i
        left join lateral (
            select array_agg(t.tag_id::bigint) as tags from sigint_inbox_item_tag t
            where t.model is null
              and t.sigint_inbox_item_id = i.id
        ) as t on true
        join signal_message m on m.id = i.id
        where i.body_noheader is not null
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
    , c.labels
    , c."text"
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
from cte c
"""


def fetch_from_postgres(con: DuckDBPyConnection, databases: list[str], file_name: str):
    con.execute("SET VARIABLE postgres_inbox_query = ?", [POSTGRES_INBOX_QUERY])

    queries = []
    for db in databases:
        con.execute(f"""ATTACH 'dbname={db}' AS "{db}" (TYPE postgres)""")
        query = f"""SELECT '{db}' as "__source", * FROM postgres_query('{db}', getvariable('postgres_inbox_query'))"""
        queries.append(query)

    combined = "\nUNION ALL\n".join(queries)
    con.execute(f"""
    CREATE TEMPORARY TABLE temp_combined AS
    WITH cte AS (
        {combined}
    )
    SELECT *
    FROM cte
    """)

    query = con.query("SELECT DISTINCT on (text, labels) * FROM temp_combined")
    query.write_parquet(file_name, row_group_size=100000)
