with candidates as materialized (
    select j.media_id, requested.accepted
    from jsonb_to_recordset($1::jsonb) as requested(
        media_id uuid, generation timestamp, extractor_id uuid, accepted boolean)
    join ocr_job j on j.media_id = requested.media_id
    join signal_message_media m on m.id = j.media_id
    where j.state = 'failed' and m.size_bytes > 0
        and j.discovered_at = requested.generation
        and j.extractor_job_id is not distinct from requested.extractor_id
        and ((requested.accepted and requested.extractor_id is not null)
            or (not requested.accepted and requested.extractor_id is null
                and j.last_error like 'OCR submission returned HTTP 507 Insufficient Storage:%'))
    for update of j
)
update ocr_job j set state = 'queued', attempts = 0, next_attempt_at = now(),
    last_error = null, quality_status = null, completed_at = null,
    processed_pages = 0, total_pages = 0, extractor_job_id = null,
    submitted_at = null, updated_at = now(),
    discovered_at = case when c.accepted then
        greatest(clock_timestamp() at time zone 'UTC', j.discovered_at + interval '1 microsecond')
        else j.discovered_at end
from candidates c where j.media_id = c.media_id
returning j.media_id, j.discovered_at;
