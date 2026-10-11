with candidates as materialized (
    select j.id, j.file_id, j.revision, j.generation
    from file_document_job j
    join file_document d on d.file_id = j.file_id
        and d.revision = j.revision and d.generation = j.generation
    where j.kind = 'extract' and j.state = 'failed' and d.state = 'failed'
        and j.lease is null and j.lease_until is null
        and not (j.payload ? 'extractorJobId')
        and j.last_error like '%507 Insufficient Storage%url (http://127.0.0.1:18080/v1/jobs)%'
    for update of j, d
), retried as (
    update file_document_job j
    set state = 'queued', attempts = 0, last_error = null,
        next_attempt_at = now(), lease = null, lease_until = null
    from candidates c where j.id = c.id
    returning j.file_id, j.revision, j.generation
), restored as (
    update file_document d
    set state = 'queued', last_error = null
    from retried j where d.file_id = j.file_id
        and d.revision = j.revision and d.generation = j.generation
    returning d.file_id
)
select count(*) as recovered from restored;
