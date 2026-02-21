from pathlib import Path

import duckdb
from duckdb import DuckDBPyRelation
from mlflow.data.dataset import Dataset


class Lake:
    def __init__(self, temp_directory: str):
        self.temp_directory = Path(temp_directory)
        self.conn = duckdb.connect(
            config={
                "temp_directory": temp_directory,
                "memory_limit": "8GB",
                "allocator_background_threads": True,
                "parquet_metadata_cache": True,
                "preserve_insertion_order": True,
            }
        )
        self.conn.execute("""
        INSTALL ducklake;
        LOAD ducklake;
        ATTACH 'ducklake:datalake.ducklake.duckdb' AS datalake;
        USE datalake;
        """)

    def close(self):
        self.conn.close()

    def to_plain_text(self, rel: DuckDBPyRelation, ml_dataset: Dataset) -> str:
        path = self.temp_directory / f"{ml_dataset.name}.{ml_dataset.digest}.txt"
        file_name = str(path)
        print(f"creating file '{file_name}'", flush=True)

        rel.select("text").to_csv(
            file_name,
            header=False,
            compression="none",
            use_tmp_file=True,
            sep="",
            quotechar="",
            escapechar="",
        )

        return file_name

    def merge_tags(self, db: str):
        self.conn.execute(f"""
        WITH cte AS (
            SELECT
                '{db}' AS source,
                *
            FROM postgres_query('{db}', $$
                SELECT
                      id
                    , label
                    , extra
                    , ord
                    , title
                    , enabled
                FROM
                    tag
                WHERE
                    enabled = true
            $$)
        )
        MERGE INTO tag AS tgt
        USING cte AS src ON (
            tgt.source = src.source
            AND tgt.id = src.id
        )
        WHEN NOT MATCHED BY SOURCE AND tgt.source = '{db}' THEN DELETE
        WHEN NOT MATCHED BY TARGET THEN INSERT;
        """)

    def merge_inbox_item_tags(self, db: str):
        self.conn.execute(f"""
        WITH cte AS (
            SELECT
                '{db}' AS source,
                *
            FROM postgres_query('{db}', $$
                SELECT
                      sigint_inbox_item_id
                    , tag_id
                    , login
                    , model
                    , confidence
                FROM
                    sigint_inbox_item_tag
            $$)
        )
        MERGE INTO sigint_inbox_item_tag AS tgt
        USING cte AS src ON (
            tgt.source = src.source
            AND tgt.sigint_inbox_item_id = src.sigint_inbox_item_id
            AND tgt.tag_id = src.tag_id
            AND tgt.login = src.login
            AND tgt.model = src.model
        )
        WHEN NOT MATCHED BY SOURCE AND tgt.source = '{db}' THEN DELETE
        WHEN NOT MATCHED BY TARGET THEN INSERT;
        """)

    def messages_including_unlabeled(
        self, shuffle: bool = True, seed: int = 4507
    ) -> DuckDBPyRelation:
        order_clause = ""
        if shuffle:
            order_clause = f"ORDER BY hash(source, id, {seed})"
        query = self.conn.query(rf"""
        SELECT DISTINCT ON (text)
            source,
            id,
            text
        FROM
        (
            SELECT
                source,
                id,
                normalize_body_text(body) as text
            FROM
                sigint_inbox_message
        ) AS x
        WHERE
            text <> ''
            {order_clause}
        """)
        return query

    def create_messages_labeled_onehot(
        self, shuffle: bool = True, seed: int = 4507
    ) -> DuckDBPyRelation:

        pred_order = ""
        if shuffle:
            pred_order = f"ORDER BY hash(source, id, {seed})"

        self.conn.execute(r"""
        CREATE TEMPORARY TABLE IF NOT EXISTS tmp_messages_pivot AS
        WITH cte AS (
            SELECT * FROM (
                SELECT
                    m.source,
                    m.id,
                    m.created_at,
                    normalize_body_text(m.body) AS text,
                    x.label_id,
                    x.label_value AS label_value
                FROM (
                    SELECT * FROM vw_golden_negatives
                    UNION ALL
                    SELECT * FROM vw_golden_positives
                ) AS x
                JOIN sigint_inbox_message m
                    ON m.source = x.source AND m.id = sigint_inbox_item_id
            ) AS m
            WHERE m.text <> ''
        )
        PIVOT cte
        ON label_id IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9)
        USING min(label_value) AS onehot
        GROUP BY source, id, created_at, text;
        """)

        self.conn.execute(r"""
        CREATE OR REPLACE TEMPORARY VIEW tmp_messages_labeled_onehot AS
        WITH source_flags AS (
            -- Pre-calculate first time a source EVER had a specific label (single pass)
            SELECT
                source,
                min(created_at) filter("0_onehot" = true) AS min_created_at_0,
                min(created_at) filter("1_onehot" = true) AS min_created_at_1,
                min(created_at) filter("2_onehot" = true) AS min_created_at_2,
                min(created_at) filter("3_onehot" = true) AS min_created_at_3,
                min(created_at) filter("4_onehot" = true) AS min_created_at_4,
                min(created_at) filter("5_onehot" = true) AS min_created_at_5,
                min(created_at) filter("6_onehot" = true) AS min_created_at_6,
                min(created_at) filter("7_onehot" = true) AS min_created_at_7,
                min(created_at) filter("8_onehot" = true) AS min_created_at_8,
                min(created_at) filter("9_onehot" = true) AS min_created_at_9
            FROM tmp_messages_pivot
            GROUP BY source
        )
        SELECT
            x.source,
            x.id,
            x.created_at,
            x.text,
            CASE WHEN x.created_at >= f.min_created_at_0 THEN coalesce(x."0_onehot", FALSE) END AS label_0,
            CASE WHEN x.created_at >= f.min_created_at_1 THEN coalesce(x."1_onehot", FALSE) END AS label_1,
            CASE WHEN x.created_at >= f.min_created_at_2 THEN coalesce(x."2_onehot", FALSE) END AS label_2,
            CASE WHEN x.created_at >= f.min_created_at_3 THEN coalesce(x."3_onehot", FALSE) END AS label_3,
            CASE WHEN x.created_at >= f.min_created_at_4 THEN coalesce(x."4_onehot", FALSE) END AS label_4,
            CASE WHEN x.created_at >= f.min_created_at_5 THEN coalesce(x."5_onehot", FALSE) END AS label_5,
            CASE WHEN x.created_at >= f.min_created_at_6 THEN coalesce(x."6_onehot", FALSE) END AS label_6,
            CASE WHEN x.created_at >= f.min_created_at_7 THEN coalesce(x."7_onehot", FALSE) END AS label_7,
            CASE WHEN x.created_at >= f.min_created_at_8 THEN coalesce(x."8_onehot", FALSE) END AS label_8,
            CASE WHEN x.created_at >= f.min_created_at_9 THEN coalesce(x."9_onehot", FALSE) END AS label_9
        FROM
            tmp_messages_pivot x
        JOIN
            source_flags f ON x.source = f.source
        ;
        """)

        return self.conn.query(f"""
        SELECT DISTINCT ON (text, label_0, label_1, label_2, label_3, label_4, label_5, label_6, label_7, label_8, label_9)
            *
        FROM
            tmp_messages_labeled_onehot
        {pred_order}
        """)

    def split_for_label(
        self, label_column_name: str, and_filter: str
    ) -> DuckDBPyRelation:
        return self.conn.query(f"""
        SELECT
             '__label__' || {label_column_name}::int || ' ' || text AS text,
             {label_column_name}::int AS label
        FROM
            tmp_messages_labeled_onehot
        WHERE
            {label_column_name} IS NOT NULL
            AND {and_filter}
        """)

    def insert_model_error(self, db: str):
        q_max = self.conn.query(
            """
        SELECT
            MAX(removed_at)
        FROM
            sigint_inbox_tag_model_error
        WHERE
            source = $1
        """,
            params=[db],
        ).fetchone()

        cond_removed_at = ""
        if q_max:
            (max_removed_at,) = q_max
            if max_removed_at:
                param_removed_at = max_removed_at.isoformat()
                cond_removed_at = f"WHERE removed_at > '{param_removed_at}'::TIMESTAMP"

        self.conn.execute(
            f"""
        INSERT INTO sigint_inbox_tag_model_error
        SELECT
            '{db}' AS source,
            *
        FROM
            postgres_query('{db}',
        $$
            SELECT
                id,
                tag_id,
                sigint_inbox_item_id,
                model,
                model_login,
                confidence,
                removed_by_login,
                removed_at
            FROM
                sigint_inbox_tag_model_error
            {cond_removed_at}
        $$)
        """
        )

    def insert_inbox_message(self, db: str):
        q_max = self.conn.query(
            """
        SELECT
            MAX(created_at)
        FROM
            sigint_inbox_message
        WHERE
            source = $1
        """,
            params=[db],
        ).fetchone()

        cond_created_at = ""
        if q_max:
            (max_created_at,) = q_max
            if max_created_at:
                param_created_at = max_created_at.isoformat()
                cond_created_at = f"AND m.created_at > '{param_created_at}'::TIMESTAMP"

        self.conn.execute(
            f"""
        INSERT INTO sigint_inbox_message
        SELECT
            '{db}' AS source,
            *
        FROM
            postgres_query('{db}',
        $$
            SELECT
                i.id
                , m.created_at AT TIME ZONE 'UTC' AS created_at
                , i."datetime" AT TIME ZONE 'UTC' AS "datetime"
                , i.body_noheader->>'body' AS body
                , (i.body_noheader->'start')::INT AS body_start
                , (i.body_noheader->'end')::INT AS body_end
            FROM
                sigint_inbox_item i
            JOIN
                signal_message m
                    ON m.id = i.id
            WHERE
                i.body_noheader IS NOT NULL
                AND i.body_noheader->>'body' IS NOT NULL
                AND i.body_noheader->>'body' <> ''
                {cond_created_at}
        $$)
        """
        )

    def attach_local(self, db: str):
        self.conn.execute(f"""
        INSTALL postgres;
        LOAD postgres;
        ATTACH 'dbname={db}' AS "{db}" (TYPE postgres);
        """)

    def attach_remote(self, db: str):
        self.conn.execute(f"""
        INSTALL postgres;
        LOAD postgres;
        ATTACH 'dbname=wd host={db}' AS "{db}" (TYPE postgres);
        """)

    def get_label_dict(self, label_list: list[str]) -> dict[int, str]:
        unique_labels = self.conn.query(
            "SELECT DISTINCT ON (label_id) * FROM label ORDER BY label_id"
        ).fetchall()
        all_labels = {label_id: label_text for label_id, label_text in unique_labels}

        if label_list:
            label_dict = {
                key: value
                for key, value in all_labels.items()
                if value in label_list or str(key) in label_list
            }
            return label_dict
        else:
            return all_labels

    def detach(self, db: str):
        self.conn.execute(f"""DETACH "{db}";""")

    def create_schema_if_not_exists(self):
        script = Path(__file__).parent / "lake.sql"
        self.conn.execute(script.read_text())
