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
        CALL ducklake_expire_snapshots('datalake', older_than => now() - INTERVAL '1 week');
        CALL ducklake_cleanup_old_files('datalake', cleanup_all => true);
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

    def create_messages_labeled_onehot(self) -> DuckDBPyRelation:
        self.conn.execute("""
            CREATE TEMPORARY TABLE IF NOT EXISTS tmp_messages_labeled_onehot AS
            SELECT * FROM vw_messages_labeled_onehot;
        """)

        return self.conn.table("tmp_messages_labeled_onehot")

    def split_for_label(
        self, label_column_name: str, split: str, shuffle_seed: int | None
    ) -> DuckDBPyRelation:
        train_pct = 0.90
        validation_pct = 0.05

        self.conn.execute(f"""
        CREATE TEMPORARY TABLE IF NOT EXISTS tmp_{label_column_name}_splits AS
        WITH ranked_data AS (
            SELECT
                *,
                PERCENT_RANK() OVER (
                    PARTITION BY {label_column_name}
                    ORDER BY created_at ASC
                ) as time_percentile
            FROM tmp_messages_labeled_onehot
            WHERE {label_column_name} IS NOT NULL
        )
        SELECT
            *,
            CASE
                WHEN time_percentile <= {train_pct} THEN 'train'
                WHEN time_percentile <= {train_pct + validation_pct} THEN 'validation'
                ELSE 'test'
            END as split_group
        FROM ranked_data;
        """)

        order_clause = "ORDER BY created_at"
        if shuffle_seed is not None:
            order_clause = f"ORDER BY hash(source, id, {shuffle_seed})"

        return self.conn.query(f"""
        SELECT
             '__label__' || {label_column_name}::int || ' ' || text AS text,
             {label_column_name}::int AS label
        FROM
            tmp_{label_column_name}_splits
        WHERE
            split_group = '{split}'
        {order_clause}
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
