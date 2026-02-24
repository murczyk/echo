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
    t.enabled = TRUE AND (
    mt.model IS NULL OR (
        mt.confidence >= 0.8 AND EXISTS (
                SELECT 1 FROM sigint_inbox_item_tag t
                WHERE t.source = mt.source
                  AND t.sigint_inbox_item_id = mt.sigint_inbox_item_id
                  AND t.model IS NULL
                UNION ALL
                SELECT 1 FROM sigint_inbox_tag_model_error e
                WHERE e.source = mt.source
                  AND e.sigint_inbox_item_id = mt.sigint_inbox_item_id
            )
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

CREATE OR REPLACE TEMPORARY VIEW vw_messages_labeled AS
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
WHERE m.text <> '';

CREATE OR REPLACE TEMPORARY VIEW vw_messages_labeled_onehot AS
WITH messages_pivot AS (
    PIVOT vw_messages_labeled
    ON label_id IN (0, 1, 2, 3, 4, 5, 6, 7, 8, 9)
    USING min(label_value) AS onehot
    GROUP BY source, id, created_at, text
),
source_flags AS (
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
    FROM messages_pivot
    GROUP BY source
)
SELECT DISTINCT ON (text, label_0, label_1, label_2, label_3, label_4, label_5, label_6, label_7, label_8, label_9)
    *
FROM (
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
        messages_pivot x
    JOIN
        source_flags f ON x.source = f.source
);
