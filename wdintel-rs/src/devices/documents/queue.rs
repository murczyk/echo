use crate::{
    attachments::store::{execute, rows},
    config::OCR_MAX_ERROR_CHARS,
    devices::config::*,
    h,
    types::{Env, ShortContext},
};
use sea_orm::{ConnectionTrait, FromQueryResult, TransactionTrait};
use uuid::Uuid;

#[derive(Clone, FromQueryResult)]
pub(super) struct Job {
    pub id: Uuid,
    pub file_id: Uuid,
    pub revision: i64,
    pub generation: Uuid,
    pub kind: String,
    pub lease: Uuid,
    pub attempts: i32,
    pub payload: serde_json::Value,
}

pub(super) async fn discover(env: &Env) -> anyhow::Result<()> {
    let db = env.file_registry_db().c(h!())?.connection();
    execute(db,"with checkpoint as (select * from file_document_backfill where id=1 and not complete for update), batch as materialized (
      select c.file_id,c.revision,r.device_id from checkpoint b cross join lateral (
        select file_id,revision from file_content
        where origin_archive_id is null and (file_id,revision)>(coalesce(b.cursor_file,'00000000-0000-0000-0000-000000000000'::uuid),coalesce(b.cursor_revision,0))
        order by file_id,revision limit $1
      ) c join file_revision r on r.id=c.file_id and r.revision=c.revision and r.origin_archive_id is null
    ), inserted as (
      insert into file_document(file_id,revision,device_id,generation)
      select file_id,revision,device_id,uuid_generate_v7() from batch on conflict do nothing returning *
    ), queued as (
      insert into file_document_job(id,file_id,revision,generation,kind)
      select uuid_generate_v7(),file_id,revision,generation,'extract' from inserted on conflict do nothing
    ) update file_document_backfill set cursor_file=coalesce((select file_id from batch order by file_id desc,revision desc limit 1),cursor_file),
      cursor_revision=coalesce((select revision from batch order by file_id desc,revision desc limit 1),cursor_revision),
      discovered=discovered+(select count(*) from inserted),complete=not exists(select 1 from batch) where id=1 and not complete",
      vec![DEVICE_DOCUMENT_DISCOVERY_BATCH.into()]).await.c(h!())?;
    Ok(())
}

pub(super) async fn claim(
    env: &Env,
    kind: &str,
) -> anyhow::Result<Option<Job>> {
    let lease = Uuid::now_v7();
    Ok(rows::<Job,_>(env.file_registry_db().c(h!())?.connection(),"with selected as (
      select j.id from file_document_job j join file_document d on d.file_id=j.file_id and d.revision=j.revision
      where j.kind=$1 and (j.kind='inspect' or j.generation=d.generation) and j.next_attempt_at<=now()
      and (j.state in ('queued','retry_wait') or j.state='running' and j.lease_until<now())
      order by j.created_at desc,j.id limit 1 for update of j skip locked
    ) update file_document_job j set state='running',lease=$2,lease_until=now()+make_interval(secs=>$3),attempts=attempts+1
      from selected where j.id=selected.id returning j.*",vec![kind.into(),lease.into(),(DEVICE_DOCUMENT_LEASE_SECS as f64).into()]).await.c(h!())?.pop())
}

pub(super) async fn renew(
    db: &impl ConnectionTrait,
    job: &Job,
) -> anyhow::Result<()> {
    let count=execute(db,"update file_document_job j set lease_until=now()+make_interval(secs=>$3)
      where j.id=$1 and j.lease=$2 and j.lease_until>now() and j.state='running'
      and (j.kind='inspect' or exists(select 1 from file_document d where d.file_id=j.file_id and d.revision=j.revision and d.generation=j.generation))",
      vec![job.id.into(),job.lease.into(),(DEVICE_DOCUMENT_LEASE_SECS as f64).into()]).await.c(h!())?;
    anyhow::ensure!(count == 1, "document job lease lost");
    Ok(())
}

pub(super) async fn finish(
    env: &Env,
    job: &Job,
    outcome: anyhow::Result<bool>,
) -> anyhow::Result<()> {
    let db = env.file_registry_db().c(h!())?.connection();
    let tx = db.begin().await.c(h!())?;
    let (state, error) = match outcome {
        Ok(true) => ("completed", None),
        Ok(false) => ("queued", None),
        Err(error) => {
            crate::types::error!(
                "device document {} {}: {error:#}",
                job.kind,
                job.id
            );
            (
                if job.attempts >= DEVICE_DOCUMENT_MAX_ATTEMPTS {
                    "failed"
                } else {
                    "retry_wait"
                },
                Some(
                    format!("{error:#}")
                        .chars()
                        .take(OCR_MAX_ERROR_CHARS)
                        .collect::<String>(),
                ),
            )
        }
    };
    let changed=execute(&tx,"update file_document_job set state=$3,last_error=$4,lease=null,lease_until=null,
      attempts=case when $3='queued' then greatest(attempts-1,0) else attempts end,
      next_attempt_at=now()+make_interval(secs=>$5) where id=$1 and lease=$2",
      vec![job.id.into(),job.lease.into(),state.into(),error.clone().into(),(10.0*2f64.powi(job.attempts.min(6))).into()]).await.c(h!())?;
    if changed > 0 && state == "failed" && job.kind != "inspect" {
        execute(&tx,"update file_document set last_error=$4,state=case when $5='extract' then 'failed' else state end where file_id=$1 and revision=$2 and generation=$3",
            vec![job.file_id.into(),job.revision.into(),job.generation.into(),error.into(),job.kind.clone().into()]).await.c(h!())?;
        execute(&tx,"update file_document_generation set summary_state=case when $2='summary' then 'failed' else summary_state end,position_state=case when $2='positions' then 'failed' else position_state end where id=$1",vec![job.generation.into(),job.kind.clone().into()]).await.c(h!())?;
    }
    tx.commit().await.c(h!())?;
    Ok(())
}

pub(super) async fn enqueue(
    db: &impl ConnectionTrait,
    file: Uuid,
    revision: i64,
    generation: Uuid,
    kind: &str,
) -> anyhow::Result<()> {
    execute(db,"insert into file_document_job(id,file_id,revision,generation,kind) values($1,$2,$3,$4,$5) on conflict do nothing",
        vec![Uuid::now_v7().into(),file.into(),revision.into(),generation.into(),kind.into()]).await.c(h!())?;
    Ok(())
}
