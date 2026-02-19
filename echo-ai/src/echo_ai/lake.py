import os
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
                FROM
                    sigint_inbox_item_tag
                WHERE
                    model IS NULL
            $$)
        )
        MERGE INTO sigint_inbox_item_tag AS tgt
        USING cte AS src ON (
            tgt.source = src.source
            AND tgt.sigint_inbox_item_id = src.sigint_inbox_item_id
            AND tgt.tag_id = src.tag_id
            AND tgt.login = src.login
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
                array_to_string(
                    regexp_extract_all(
                        lower(
                            coalesce(nullif(regexp_replace(body, '^[^—]*—\s*', ''), ''), body)
                        ),
                        $$[\pL\pN_`'’ʼ]+$$
                    ),
                    ' '
                ) AS text
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
            SELECT
                m.source,
                m.id,
                m.created_at,
                array_to_string(
                    regexp_extract_all(
                        lower(
                            coalesce(nullif(regexp_replace(m.body, '^[^—]*—\s*', ''), ''), m.body)
                        ),
                        $$[\pL\pN_`'’ʼ]+$$
                    ),
                    ' '
                ) AS text,
                l.label_id
            FROM
                sigint_inbox_message m
            JOIN
                sigint_inbox_item_tag mt on m.source = mt.source AND m.id = mt.sigint_inbox_item_id
            JOIN
                tag t ON mt.source = t.source AND mt.tag_id = t.id
            JOIN
                label l ON t.label = l.label_text
        )
        PIVOT cte
        ON label_id IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9)
        USING coalesce(max(label_id = label_id)::BOOLEAN, FALSE) AS onehot
        """)

        self.conn.execute(r"""
        CREATE OR REPLACE VIEW tmp_messages_labeled_onehot AS
        SELECT DISTINCT ON (text, "0_onehot", "1_onehot", "2_onehot", "3_onehot", "4_onehot", "5_onehot", "6_onehot", "7_onehot", "8_onehot", "9_onehot")
            source,
            id,
            created_at,
            text,
            label_0: "0_onehot",
            label_1: "1_onehot",
            label_2: "2_onehot",
            label_3: "3_onehot",
            label_4: "4_onehot",
            label_5: "5_onehot",
            label_6: "6_onehot",
            label_7: "7_onehot",
            label_8: "8_onehot",
            label_9: "9_onehot"
        FROM
            tmp_messages_pivot
        WHERE
            text <> ''
        """)
        return self.conn.query(
            f"SELECT * FROM tmp_messages_labeled_onehot {pred_order}"
        )

    def split_for_label(
        self, label_column_name: str, and_filter: str
    ) -> DuckDBPyRelation:
        self.create_messages_labeled_onehot()
        return self.conn.query(f"""
        SELECT
             '__label__' || {label_column_name}::int || ' ' || text AS text,
             {label_column_name}::int AS label
        FROM
            tmp_messages_labeled_onehot
        WHERE
            {label_column_name} IS NOT NULL
            AND (label_0 OR label_1 OR label_2 OR label_3 OR label_4 OR label_5 OR label_6 OR label_7 OR label_8 OR label_9)
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

    def detach(self, db: str):
        self.conn.execute(f"""DETACH "{db}";""")

    def create_schema_if_not_exists(self):
        self.conn.execute(r"""
        CREATE OR REPLACE VIEW label(label_id, label_text) AS
        (
            VALUES
            (0, 'переміщення'),
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
        );

        CREATE TABLE IF NOT EXISTS tag (
            source VARCHAR NOT NULL,
            id BIGINT NOT NULL,
            label VARCHAR NOT NULL,
            extra BOOLEAN NOT NULL,
            ord DOUBLE NULL,
            title VARCHAR NULL,
            enabled BOOLEAN NOT NULL
        );
        ALTER TABLE tag SET PARTITIONED BY (source);

        CREATE TABLE IF NOT EXISTS sigint_inbox_item_tag (
            source VARCHAR NOT NULL,
            sigint_inbox_item_id BIGINT NOT NULL,
            tag_id BIGINT NOT NULL,
            login VARCHAR NULL
        );
        ALTER TABLE sigint_inbox_item_tag SET PARTITIONED BY (source);

        CREATE TABLE IF NOT EXISTS sigint_inbox_message (
            source VARCHAR NOT NULL,
            id BIGINT NOT NULL,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL,
            datetime TIMESTAMP WITH TIME ZONE NULL,
            body VARCHAR NOT NULL,
            body_start INT NULL,
            body_end INT NULL
        );
        ALTER TABLE sigint_inbox_message SET PARTITIONED BY (source, year(created_at), month(created_at));

        CREATE TABLE IF NOT EXISTS sigint_inbox_tag_model_error (
            source VARCHAR NOT NULL,
            id BIGINT NOT NULL,
            tag_id BIGINT NOT NULL,
            sigint_inbox_item_id BIGINT NOT NULL,
            model VARCHAR NOT NULL,
            model_login VARCHAR NULL,
            confidence DOUBLE NOT NULL,
            removed_by_login VARCHAR NOT NULL,
            removed_at TIMESTAMP WITH TIME ZONE NOT NULL
        );
        ALTER TABLE sigint_inbox_tag_model_error SET PARTITIONED BY (source);
        """)
