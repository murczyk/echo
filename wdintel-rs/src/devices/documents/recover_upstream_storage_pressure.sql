with candidates as materialized (
    select j.id, j.file_id, j.revision, j.generation
    from jsonb_to_recordset($1::jsonb) as requested(id uuid, extractor_id text, generation uuid)
    join file_document_job j on j.id = requested.id
    join file_document d on d.file_id = j.file_id
        and d.revision = j.revision and d.generation = j.generation
    where j.kind = 'extract' and j.state = 'failed' and d.state = 'failed'
        and j.lease is null and j.lease_until is null
        and j.payload->>'extractorJobId' = requested.extractor_id
        and j.generation = requested.generation
        and exists (select 1 from file_content c
            where c.file_id = j.file_id and c.revision = j.revision)
    for update of j, d
), retried as (
    update file_document_job j
    set state = 'queued', attempts = 0, last_error = null,
        next_attempt_at = now(), lease = null, lease_until = null
    from candidates c where j.id = c.id
    returning j.id, j.file_id, j.revision, j.generation
), restored as (
    update file_document d set state = 'queued', last_error = null
    from retried j where d.file_id = j.file_id
        and d.revision = j.revision and d.generation = j.generation
    returning d.file_id, d.revision, d.generation
)
select j.id from retried j join restored d using (file_id, revision, generation);
