CREATE OR REPLACE TEMPORARY VIEW label(label_id, label_text) AS
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
    login VARCHAR NULL,
    model VARCHAR NULL,
    confidence DOUBLE NOT NULL
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

-- grab all "bot is wrong" feedback as negative samples
CREATE OR REPLACE TEMPORARY VIEW vw_golden_negatives AS
SELECT
    me.source,
    me.sigint_inbox_item_id,
    l.label_id,
    FALSE as label_value
FROM
    sigint_inbox_tag_model_error me
JOIN
    tag t ON me.source = t.source AND me.tag_id = t.id
JOIN
    label l ON t.label = l.label_text
WHERE
    t.enabled = TRUE
GROUP BY me.source, me.sigint_inbox_item_id, l.label_id;

-- include all user-created tags as positive samples
-- and bot tags as well in case there is another user-applied tag or "bot is wrong feedback"
CREATE OR REPLACE TEMPORARY VIEW vw_golden_positives AS
SELECT
    mt.source,
    mt.sigint_inbox_item_id,
    l.label_id,
    TRUE AS label_value
FROM
    sigint_inbox_item_tag mt
JOIN
    tag t ON mt.source = t.source AND mt.tag_id = t.id
JOIN
    label l ON t.label = l.label_text
WHERE
    t.enabled = TRUE
    AND (
        mt.model IS NULL
        OR EXISTS (
            SELECT 1 FROM sigint_inbox_item_tag t
            WHERE t.source = mt.source AND t.sigint_inbox_item_id = mt.sigint_inbox_item_id
              AND t.model IS NULL
        )
        OR EXISTS (
            SELECT 1 FROM sigint_inbox_tag_model_error e
            WHERE e.source = mt.source AND e.sigint_inbox_item_id = mt.sigint_inbox_item_id
        )
    )
GROUP BY mt.source, mt.sigint_inbox_item_id, l.label_id;

CREATE TEMPORARY MACRO normalize_body_text(body) AS array_to_string(
    regexp_extract_all(
        lower(
            coalesce(nullif(regexp_replace(body, '^[^—]*—\s*', ''), ''), body)
        ),
        '[\pL\pN_`''’ʼ]+'
    ),
    ' '
);
