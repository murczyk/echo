import csv
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
        ATTACH 'ducklake:datalake.ducklake' AS datalake;
        USE datalake;
        """)

    def close(self):
        self.conn.close()

    def to_plain_text(self, rel: DuckDBPyRelation, ml_dataset: Dataset) -> str:
        path = self.temp_directory / f"{ml_dataset.name}.{ml_dataset.digest}.txt"
        file_name = str(path)
        print(f"creating file '{file_name}'")

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
        WITH cte AS NOT MATERIALIZED (
            SELECT
                '{db}' AS source
                , id
                , label
                , extra
                , ord
                , title
                , enabled
            FROM
                "{db}".tag
        )
        MERGE INTO tag AS tag
        USING cte ON (
            tag.source = cte.source
            AND tag.id = cte.id
        )
        WHEN NOT MATCHED BY SOURCE THEN DELETE
        WHEN NOT MATCHED BY TARGET THEN INSERT;
        """)

    def merge_inbox_item_tags(self, db: str):
        self.conn.execute(f"""
        WITH cte AS NOT MATERIALIZED (
            SELECT
                '{db}' AS source
                , sigint_inbox_item_id
                , tag_id
                , login
            FROM
                "{db}".sigint_inbox_item_tag
            WHERE
                model IS NULL
        )
        MERGE INTO sigint_inbox_item_tag AS sigint_inbox_item_tag
        USING cte ON (
            sigint_inbox_item_tag.source = cte.source
            AND sigint_inbox_item_tag.sigint_inbox_item_id = cte.sigint_inbox_item_id
            AND sigint_inbox_item_tag.tag_id = cte.tag_id
        )
        WHEN NOT MATCHED BY SOURCE THEN DELETE
        WHEN NOT MATCHED BY TARGET THEN INSERT;
        """)

    def create_messages_labeled_onehot(
        self, shuffle: bool = True, seed: int = 4507
    ) -> DuckDBPyRelation:

        pred_order = ""
        if shuffle:
            pred_order = f"ORDER BY hash(source, id, {seed})"

        self.conn.execute(rf"""
        CREATE TEMPORARY TABLE IF NOT EXISTS tmp_messages_labeled_onehot AS
        WITH cte AS NOT MATERIALIZED (
            SELECT
                text: array_to_string(regexp_extract_all(lower(text), $$[\pL\pN_`'’ʼ]+$$), ' '),
                * EXCLUDE(text),
                min_label_0: MIN(created_at) FILTER (label_0 = true) OVER (PARTITION BY source),
                min_label_1: MIN(created_at) FILTER (label_1 = true) OVER (PARTITION BY source),
                min_label_2: MIN(created_at) FILTER (label_2 = true) OVER (PARTITION BY source),
                min_label_3: MIN(created_at) FILTER (label_3 = true) OVER (PARTITION BY source),
                min_label_4: MIN(created_at) FILTER (label_4 = true) OVER (PARTITION BY source),
                min_label_5: MIN(created_at) FILTER (label_5 = true) OVER (PARTITION BY source),
                min_label_6: MIN(created_at) FILTER (label_6 = true) OVER (PARTITION BY source),
                min_label_7: MIN(created_at) FILTER (label_7 = true) OVER (PARTITION BY source),
                min_label_8: MIN(created_at) FILTER (label_8 = true) OVER (PARTITION BY source),
                min_label_9: MIN(created_at) FILTER (label_9 = true) OVER (PARTITION BY source)
            FROM
                messages_labeled_onehot
        )
        SELECT
            text,
            body,
            source,
            id,
            created_at,
            datetime,
            labels,
            label_0: CASE WHEN created_at >= min_label_0 THEN label_0 END,
            label_1: CASE WHEN created_at >= min_label_1 THEN label_1 END,
            label_2: CASE WHEN created_at >= min_label_2 THEN label_2 END,
            label_3: CASE WHEN created_at >= min_label_3 THEN label_3 END,
            label_4: CASE WHEN created_at >= min_label_4 THEN label_4 END,
            label_5: CASE WHEN created_at >= min_label_5 THEN label_5 END,
            label_6: CASE WHEN created_at >= min_label_6 THEN label_6 END,
            label_7: CASE WHEN created_at >= min_label_7 THEN label_7 END,
            label_8: CASE WHEN created_at >= min_label_8 THEN label_8 END,
            label_9: CASE WHEN created_at >= min_label_9 THEN label_9 END,
        FROM
            cte
        WHERE
            text <> ''
        {pred_order}
        ;
        """)
        return self.conn.table("tmp_messages_labeled_onehot")

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
            AND LENGTH(labels) > 0
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
        xdg_runtime_dir = os.getenv("XDG_RUNTIME_DIR")

        if xdg_runtime_dir:
            xdg_runtime_dir = Path(xdg_runtime_dir)
        else:
            uid = os.getuid()
            xdg_runtime_dir = Path(f"/run/user/{uid}")

        pg_host = xdg_runtime_dir / "pg-ssh-tunnel-proxy" / db
        self.conn.execute(f"""
        INSTALL postgres;
        LOAD postgres;
        ATTACH 'dbname=wd host={pg_host}' AS "{db}" (TYPE postgres);
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

        CREATE OR REPLACE VIEW messages_trimmed AS
        WITH cte1 AS NOT MATERIALIZED (
            SELECT
                m.body,
                body_trim_dash: regexp_replace(m.body, '(?sm)\A.+?^\s*(?:1\.|[-—]+|$)', '', 'sm'),
                body_trim_emptyline: regexp_replace(m.body, '(?sm)\A.+?^$', '', 'sm'),
                m.source,
                m.id,
                m.created_at,
                m.datetime
            FROM
                sigint_inbox_message m
        ), cte2 AS NOT MATERIALIZED (
            SELECT
                CASE
                    WHEN regexp_matches(body, '(?sm)\A(?:1\.|[-—]+)\s+', 'sm') THEN body
                    WHEN body_trim_dash <> '' AND length(body_trim_dash) < length(body_trim_emptyline) THEN body_trim_dash
                    WHEN body_trim_emptyline <> '' THEN body_trim_emptyline
                    ELSE body
                END AS text,
                * EXCLUDE(body_trim_dash, body_trim_emptyline)
            FROM
                cte1
        )
        SELECT
            text: regexp_replace(text, '(?m)^[0-9][.-—]', '', 'gm'),
            * EXCLUDE(text)
        FROM
            cte2
        WHERE
            text <> ''
        ;

        CREATE OR REPLACE VIEW messages_labeled AS
        WITH cte1 AS (
            SELECT
                mt.source,
                mt.sigint_inbox_item_id,
                list(l.label_id) as labels
            FROM
                sigint_inbox_item_tag mt
            JOIN
                tag t ON mt.tag_id = t.id
            JOIN
                label l ON t.label = l.label_text
            GROUP BY
                mt.source,
                mt.sigint_inbox_item_id
        )
        SELECT
            m.*,
            COALESCE(ml.labels, []::INT[]) AS labels
        FROM
            messages_trimmed m
        LEFT JOIN
            cte1 ml
                ON m.source = ml.source
               AND m.id = ml.sigint_inbox_item_id
        ;

        CREATE OR REPLACE VIEW messages_labeled_onehot AS
        SELECT
            *,
            label_0: list_contains(labels, 0),
            label_1: list_contains(labels, 1),
            label_2: list_contains(labels, 2),
            label_3: list_contains(labels, 3),
            label_4: list_contains(labels, 4),
            label_5: list_contains(labels, 5),
            label_6: list_contains(labels, 6),
            label_7: list_contains(labels, 7),
            label_8: list_contains(labels, 8),
            label_9: list_contains(labels, 9)
        FROM
            messages_labeled;

        """)
