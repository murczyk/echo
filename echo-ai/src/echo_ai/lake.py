from pathlib import Path

import duckdb
import pandas as pd
from duckdb import DuckDBPyRelation
from mlflow.data.dataset import Dataset


class Lake:
    def __init__(self, temp_directory: str):
        self.temp_directory = Path(temp_directory)
        self.conn = duckdb.connect(
            config={
                "temp_directory": temp_directory,
                "memory_limit": "10GB",
                "allocator_background_threads": True,
                "parquet_metadata_cache": True,
                "preserve_insertion_order": False,
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

    def merge_tag_keywords(self, db: str):
        self.conn.execute(f"""
        CREATE OR REPLACE TEMPORARY TABLE tmp_tag_keyword AS
        SELECT
            '{db}' AS source,
            *
        FROM postgres_query('{db}', $$
            SELECT
                tag_keyword_id
                , tag_id
                , keyword
                , keyword_forms
                , is_regex
                , keyword_negative_forms
            FROM
                tag_keyword
        $$);

        MERGE INTO tag_keyword AS tgt
        USING tmp_tag_keyword AS src ON (
            tgt.source = src.source
            AND tgt.tag_keyword_id = src.tag_keyword_id
        )
        WHEN MATCHED THEN UPDATE
        WHEN NOT MATCHED BY TARGET THEN INSERT;

        -- not possible to use both UPDATE and DELETE at same time
        MERGE INTO tag_keyword AS tgt
        USING tmp_tag_keyword AS src ON (
            tgt.source = src.source
            AND tgt.tag_keyword_id = src.tag_keyword_id
        )
        WHEN NOT MATCHED BY SOURCE AND tgt.source = '{db}' THEN DELETE
        """)

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

        self.conn.execute(r"""
        CREATE TEMPORARY TABLE IF NOT EXISTS tmp_messages_including_unlabeled AS
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
        """)

        order_clause = ""
        if shuffle:
            order_clause = f"ORDER BY hash(source, id, {seed})"

        query = self.conn.query(f"""
        SELECT * FROM tmp_messages_including_unlabeled
        {order_clause}
        """)

        return query

    def create_messages_labeled_onehot(self) -> DuckDBPyRelation:
        self.conn.execute("""
            CREATE TEMPORARY TABLE IF NOT EXISTS tmp_messages_labeled_onehot AS
            SELECT * FROM vw_messages_labeled_onehot;
        """)

        return self.conn.table("tmp_messages_labeled_onehot")

    def evaluate_regex(self, label_index: int, split: str) -> pd.DataFrame:
        label_column_name = f"label_{label_index}"
        self.split_for_label(label_column_name, split, shuffle_seed=None)

        q = self.conn.query(rf"""
            WITH neg_forms AS (
                SELECT k.source, is_regex, unnest(keyword_negative_forms) keyword
                FROM tag_keyword k
                JOIN tag t on k.source = t.source and t.id = k.tag_id
                JOIN label l on l.label_text = t.label
                WHERE l.label_id = {label_index}
            ), pos_forms AS (
                SELECT k.source, is_regex, unnest(keyword_forms) keyword
                FROM tag_keyword k
                JOIN tag t on k.source = t.source and t.id = k.tag_id
                JOIN label l on l.label_text = t.label
                WHERE l.label_id = {label_index}
            )
            SELECT {label_column_name}::int AS y_true,
                   (NOT EXISTS(
                        SELECT 1 FROM neg_forms nf
                        WHERE nf.source = s.source
                          AND CASE WHEN nf.is_regex THEN regexp_matches(s.text, nf.keyword) ELSE contains(s.text, nf.keyword) END
                   ) AND EXISTS(
                        SELECT 1 FROM pos_forms pf
                        WHERE pf.source = s.source
                          AND CASE WHEN pf.is_regex THEN regexp_matches(s.text, pf.keyword) ELSE contains(s.text, pf.keyword) END
                   ))::int AS y_pred
            FROM tmp_{label_column_name}_splits s
            WHERE split_name = '{split}'
        """)

        return q.df()

    def split_for_label(
        self, label_column_name: str, split: str, shuffle_seed: int | None
    ) -> DuckDBPyRelation:
        min_positive_samples = 1000
        min_days_ago = 7
        max_days_ago = 90

        self.conn.execute(f"""
        CREATE TEMPORARY TABLE IF NOT EXISTS tmp_{label_column_name}_splits AS
        WITH target_data AS (
            -- 1. Filter to your specific label and exclude pre-source records (NULLs)
            SELECT
                *,
                {label_column_name} AS is_positive
            FROM tmp_messages_labeled_onehot
            WHERE {label_column_name} IS NOT NULL
        ),
        test_stats AS (
            -- 2. Calculate running positive totals backward from the most recent date
            SELECT
                *,
                MAX(created_at) OVER () AS max_date,
                SUM(is_positive) OVER (ORDER BY created_at DESC) AS test_running_positives,
                MAX(created_at) OVER () - created_at AS test_time_diff
            FROM target_data
        ),
        test_cutoff_cte AS (
            -- 3. Find the exact Test cutoff date
            -- Looks for the most recent date where >= {min_positive_samples} positives AND >= {min_days_ago} days are met.
            -- Caps the lookback at {max_days_ago} days maximum.
            SELECT
                GREATEST(
                    MAX(max_date) - INTERVAL {max_days_ago} DAYS,
                    COALESCE(
                        MAX(CASE
                            WHEN test_running_positives >= {min_positive_samples}
                             AND test_time_diff >= INTERVAL {min_days_ago} DAYS
                            THEN created_at
                        END),
                        MAX(max_date) - INTERVAL {max_days_ago} DAYS
                    )
                ) AS test_cutoff
            FROM test_stats
        ),
        val_stats AS (
            -- 4. Calculate running positive totals backward from the new Test cutoff date
            SELECT
                t.*,
                c.test_cutoff,
                SUM(t.is_positive) OVER (ORDER BY t.created_at DESC) AS val_running_positives,
                c.test_cutoff - t.created_at AS val_time_diff
            FROM target_data t
            CROSS JOIN test_cutoff_cte c
            WHERE t.created_at < c.test_cutoff
        ),
        val_cutoff_cte AS (
            -- 5. Find the exact Validation cutoff date using the same rules
            SELECT
                GREATEST(
                    MAX(test_cutoff) - INTERVAL {max_days_ago} DAYS,
                    COALESCE(
                        MAX(CASE
                            WHEN val_running_positives >= {min_positive_samples}
                             AND val_time_diff >= INTERVAL {min_days_ago} DAYS
                            THEN created_at
                        END),
                        MAX(test_cutoff) - INTERVAL {max_days_ago} DAYS
                    )
                ) AS val_cutoff
            FROM val_stats
        )
        -- 6. Assign final splits to the underlying data
        SELECT
            d.*,
            CASE
                WHEN d.created_at >= tc.test_cutoff THEN 'test'
                WHEN d.created_at >= vc.val_cutoff AND d.created_at < tc.test_cutoff THEN 'validation'
                ELSE 'train'
            END AS split_name
        FROM target_data d
        CROSS JOIN test_cutoff_cte tc
        CROSS JOIN val_cutoff_cte vc;
        """)

        order_clause = "ORDER BY created_at"
        if shuffle_seed is not None:
            order_clause = f"ORDER BY hash(source, id, {shuffle_seed})"

        split_clause = f"WHERE split_name = '{split}'" if split else ""

        return self.conn.query(f"""
        SELECT
             '__label__' || {label_column_name}::int || ' ' || text AS text,
             {label_column_name}::int AS label
        FROM
            tmp_{label_column_name}_splits
        {split_clause}
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
