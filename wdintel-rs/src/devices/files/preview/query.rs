use crate::{devices::config::*, h};
use anyhow::{Context, Result};
use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, FromQueryResult,
    Statement, TransactionTrait, Value,
};
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(super) struct Rejection(pub &'static str);

fn statement(sql: &str, values: Vec<Value>) -> Statement {
    Statement::from_sql_and_values(DatabaseBackend::Postgres, sql, values)
}

async fn lock_admission<C: ConnectionTrait>(db: &C) -> Result<()> {
    db.execute_raw(statement(
        "select pg_advisory_xact_lock($1)",
        vec![DEVICE_FILE_PREVIEW_GEODATA_ADMISSION_LOCK.into()],
    ))
    .await
    .context(h!())?;
    Ok(())
}

pub(super) async fn load(
    db: &DatabaseConnection,
    generation: Uuid,
) -> Result<Option<Preview>> {
    Preview::find_by_statement(statement(
        "select * from file_preview where generation=$1",
        vec![generation.into()],
    ))
    .one(db)
    .await
    .context(h!())
}

#[cfg(test)]
pub(super) async fn current(
    db: &DatabaseConnection,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
) -> Result<Option<Preview>> {
    current_selection(db, (device_id, file_id, revision), None)
        .await
        .context(h!())
}

pub(super) async fn current_selection(
    db: &DatabaseConnection,
    target: (Uuid, Uuid, i64),
    archive_members: Option<&str>,
) -> Result<Option<Preview>> {
    let (device_id, file_id, revision) = target;
    Preview::find_by_statement(statement("select p.* from file_preview p join file_content c on c.file_id=p.source_file_id and c.revision=p.source_revision and c.object_key=p.source_object_key and c.source_sha256=p.source_sha256 and c.source_size_bytes=p.source_size_bytes and c.is_encrypted=p.source_is_encrypted where p.device_id=$1 and p.file_id=$2 and p.revision=$3 and p.kind='geodata_kmz' and p.archive_members is not distinct from $5 and p.is_current and p.converter_version=$4 and (p.state <> 'ready' or p.expires_at > now())", vec![device_id.into(),file_id.into(),revision.into(),DEVICE_FILE_PREVIEW_GEODATA_CONVERTER_VERSION.into(),archive_members.into()])).one(db).await.context(h!())
}

#[cfg(test)]
pub(super) async fn prepare(
    db: &DatabaseConnection,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
    expected: Option<Uuid>,
) -> Result<Uuid> {
    prepare_with_availability(db, device_id, file_id, revision, expected, true)
        .await
        .context(h!())
}

#[cfg(test)]
pub(super) async fn prepare_with_availability(
    db: &DatabaseConnection,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
    expected: Option<Uuid>,
    available: bool,
) -> Result<Uuid> {
    prepare_selection(
        db,
        (device_id, file_id, revision),
        None,
        expected,
        available,
    )
    .await
    .context(h!())
}

pub(super) async fn prepare_selection(
    db: &DatabaseConnection,
    target: (Uuid, Uuid, i64),
    archive_members: Option<&str>,
    expected: Option<Uuid>,
    available: bool,
) -> Result<Uuid> {
    let (device_id, file_id, revision) = target;
    if let Some(members) = archive_members {
        super::archive::indices(members).context(h!())?;
    }
    let transaction = db.begin().await.context(h!())?;
    lock_admission(&transaction).await.context(h!())?;
    let source = transaction.query_one_raw(statement("select c.source_size_bytes,r.name,r.extension,r.mime_type from file_revision r join file_content c on c.file_id=r.id and c.revision=r.revision where r.device_id=$1 and r.id=$2 and r.revision=$3", vec![device_id.into(),file_id.into(),revision.into()])).await.context(h!())?.ok_or(Rejection("not_found")).context(h!())?;
    let name: String = source.try_get("", "name").context(h!())?;
    let extension: Option<String> =
        source.try_get("", "extension").context(h!())?;
    let mime_type: Option<String> =
        source.try_get("", "mime_type").context(h!())?;
    if !source_allowed(
        &name,
        extension.as_deref(),
        mime_type.as_deref(),
        archive_members,
    ) {
        return Err(Rejection("unsupported_format").into());
    }
    if source
        .try_get::<i64>("", "source_size_bytes")
        .context(h!())?
        > source_limit(archive_members) as i64
    {
        return Err(Rejection("source_too_large").into());
    }
    let previous = Preview::find_by_statement(statement("select * from file_preview where file_id=$1 and revision=$2 and kind='geodata_kmz' and archive_members is not distinct from $3 and is_current and source_file_id is not null for update", vec![file_id.into(),revision.into(),archive_members.into()])).one(&transaction).await.context(h!())?;
    if let Some(expected) = expected {
        let previous = previous
            .as_ref()
            .filter(|p| {
                p.generation == expected && p.state == "failed" && p.retryable
            })
            .ok_or(Rejection("generation_conflict"))
            .context(h!())?;
        if (chrono::Utc::now().fixed_offset() - previous.updated_at)
            .num_seconds()
            < DEVICE_FILE_PREVIEW_GEODATA_RETRY_COOLDOWN_SECONDS
        {
            return Err(Rejection("retry_cooldown").into());
        }
    } else if let Some(previous) = &previous {
        if previous.converter_version
            == DEVICE_FILE_PREVIEW_GEODATA_CONVERTER_VERSION
            && (previous.state != "ready"
                || previous
                    .expires_at
                    .is_some_and(|expiry| expiry > chrono::Utc::now()))
        {
            transaction.commit().await.context(h!())?;
            return Ok(previous.generation);
        }
    }
    if !available {
        return Err(Rejection("preview_unavailable").into());
    }
    let counts = transaction.query_one_raw(statement("select count(*) as global, count(*) filter(where device_id=$1) as device from file_preview where is_current and source_file_id is not null and state in ('queued','running','retry_wait')", vec![device_id.into()])).await.context(h!())?.context(h!())?;
    let replacing_pending =
        i64::from(previous.as_ref().is_some_and(|previous| {
            matches!(
                previous.state.as_str(),
                "queued" | "running" | "retry_wait"
            )
        }));
    if counts.try_get::<i64>("", "global").context(h!())? - replacing_pending
        >= DEVICE_FILE_PREVIEW_GEODATA_GLOBAL_PENDING
        || counts.try_get::<i64>("", "device").context(h!())?
            - replacing_pending
            >= DEVICE_FILE_PREVIEW_GEODATA_DEVICE_PENDING
    {
        return Err(Rejection("admission_full").into());
    }
    if let Some(previous) = previous {
        retire(&transaction, previous.generation)
            .await
            .context(h!())?;
    }
    let generation = Uuid::new_v4();
    let inserted = transaction.execute_raw(statement("insert into file_preview (generation,device_id,file_id,revision,source_file_id,source_revision,kind,converter_version,is_current,state,run_id,attempt,source_object_key,source_sha256,source_size_bytes,source_is_encrypted,source_name,source_extension,archive_members,not_before,output_object_key,retryable,created_at,updated_at) select $1,r.device_id,r.id,r.revision,c.file_id,c.revision,'geodata_kmz',$4,true,'queued',$1,1,c.object_key,c.source_sha256,c.source_size_bytes,c.is_encrypted,r.name,r.extension,$7,now(),$5,false,now(),now() from file_revision r join file_content c on c.file_id=r.id and c.revision=r.revision where r.device_id=$2 and r.id=$3 and r.revision=$6", vec![generation.into(),device_id.into(),file_id.into(),DEVICE_FILE_PREVIEW_GEODATA_CONVERTER_VERSION.into(),output_key(device_id,file_id,revision,generation).into(),revision.into(),archive_members.into()])).await.context(h!())?;
    if inserted.rows_affected() != 1 {
        return Err(Rejection("not_found").into());
    }
    transaction.commit().await.context(h!())?;
    Ok(generation)
}

pub(super) fn source_allowed(
    name: &str,
    extension: Option<&str>,
    mime_type: Option<&str>,
    members: Option<&str>,
) -> bool {
    if members.is_some() {
        super::archive::is_archive(name, extension, mime_type)
    } else {
        supported_source(name, extension)
    }
}

pub(super) fn source_limit(members: Option<&str>) -> u64 {
    if members.is_some() {
        DEVICE_FILE_PREVIEW_ARCHIVE_MAX_BYTES
    } else {
        DEVICE_FILE_PREVIEW_GEODATA_SOURCE_MAX_BYTES
    }
}

pub(super) fn supported_source(name: &str, extension: Option<&str>) -> bool {
    name.trim()
        .rsplit_once('.')
        .map(|(_, suffix)| suffix)
        .filter(|suffix| !suffix.is_empty() && !suffix.contains(['/', '\\']))
        .or(extension)
        .is_some_and(supported_extension)
}

fn supported_extension(extension: &str) -> bool {
    matches!(
        extension
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str(),
        "gpx"
            | "geojson"
            | "ldk"
            | "trk"
            | "are"
            | "rte"
            | "wpt"
            | "set"
            | "fit"
    )
}

fn output_key(
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
    generation: Uuid,
) -> String {
    format!("device-file-previews/{device_id}/{file_id}/{revision}/{generation}.kmz")
}

async fn retire<C: ConnectionTrait>(db: &C, generation: Uuid) -> Result<()> {
    db.execute_raw(statement("update file_preview set is_current=false,state='retired',lease=null,lease_until=null,heartbeat_at=null,updated_at=now(),cleanup_after=greatest(now(),coalesce(attempt_deadline,now())+make_interval(secs=>$2)) where generation=$1", vec![generation.into(),(DEVICE_FILE_PREVIEW_GEODATA_CLEANUP_GRACE_SECONDS as f64).into()])).await.context(h!())?;
    Ok(())
}

#[derive(Clone, Debug, sea_orm::FromQueryResult)]
pub(super) struct Preview {
    pub generation: Uuid,
    pub device_id: Uuid,
    pub file_id: Uuid,
    pub revision: i64,
    pub source_file_id: Option<Uuid>,
    pub converter_version: i32,
    pub is_current: bool,
    pub state: String,
    pub run_id: Uuid,
    pub attempt: i32,
    pub source_object_key: String,
    pub source_sha256: Vec<u8>,
    pub source_size_bytes: i64,
    pub source_is_encrypted: bool,
    pub source_name: String,
    pub archive_members: Option<String>,
    pub lease: Option<Uuid>,
    pub attempt_deadline: Option<chrono::DateTime<chrono::FixedOffset>>,
    pub output_object_key: String,
    pub result_size_bytes: Option<i64>,
    pub result_sha256: Option<Vec<u8>>,
    pub result_encrypted: Option<bool>,
    pub error_code: Option<String>,
    pub retryable: bool,
    pub created_at: chrono::DateTime<chrono::FixedOffset>,
    pub updated_at: chrono::DateTime<chrono::FixedOffset>,
    pub expires_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    pub object_deleted_at: Option<chrono::DateTime<chrono::FixedOffset>>,
    pub tombstone_until: Option<chrono::DateTime<chrono::FixedOffset>>,
}

const OWNED: &str = "p.generation=$1 and p.lease=$2 and p.is_current and p.state='running' and p.lease_until>now() and p.attempt_deadline>now() and exists(select 1 from file_content c where c.file_id=p.source_file_id and c.revision=p.source_revision and c.object_key=p.source_object_key and c.source_sha256=p.source_sha256 and c.source_size_bytes=p.source_size_bytes and c.is_encrypted=p.source_is_encrypted)";

pub(super) async fn owned(
    db: &DatabaseConnection,
    job: &Preview,
) -> Result<bool> {
    Ok(db
        .query_one_raw(statement(
            &format!("select 1 from file_preview p where {OWNED}"),
            vec![job.generation.into(), job.lease.into()],
        ))
        .await
        .context(h!())?
        .is_some())
}

pub(super) async fn claim(db: &DatabaseConnection) -> Result<Option<Preview>> {
    let transaction = db.begin().await.context(h!())?;
    lock_admission(&transaction).await.context(h!())?;
    let expired=Preview::find_by_statement(statement("select * from file_preview where is_current and state='running' and lease_until<=now() order by lease_until,generation limit 1 for update skip locked",vec![])).one(&transaction).await.context(h!())?;
    if let Some(expired) = expired {
        fail_in_transaction(
            &transaction,
            &expired,
            "conversion_timeout",
            true,
            false,
        )
        .await
        .context(h!())?;
    }
    let sql="with candidate as (select generation from file_preview where is_current and source_file_id is not null and state in ('queued','retry_wait') and not_before<=now() order by not_before,created_at,generation limit 1 for update skip locked) update file_preview p set state='running',lease=$1,lease_until=now()+make_interval(secs=>$2),heartbeat_at=now(),attempt_deadline=now()+make_interval(secs=>$3),cleanup_after=now()+make_interval(secs=>$4),updated_at=now() from candidate where p.generation=candidate.generation returning p.*";
    let job = Preview::find_by_statement(statement(
        sql,
        vec![
            Uuid::new_v4().into(),
            (DEVICE_FILE_PREVIEW_GEODATA_LEASE_SECONDS as f64).into(),
            (DEVICE_FILE_PREVIEW_GEODATA_ATTEMPT_SECONDS as f64).into(),
            ((DEVICE_FILE_PREVIEW_GEODATA_ATTEMPT_SECONDS
                + DEVICE_FILE_PREVIEW_GEODATA_CLEANUP_GRACE_SECONDS)
                as f64)
                .into(),
        ],
    ))
    .one(&transaction)
    .await
    .context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(job)
}

pub(super) async fn heartbeat(
    db: &DatabaseConnection,
    job: &Preview,
) -> Result<bool> {
    let sql=format!("update file_preview p set lease_until=least(attempt_deadline,now()+make_interval(secs=>$3)),heartbeat_at=now(),updated_at=now() where {OWNED}");
    Ok(db
        .execute_raw(statement(
            &sql,
            vec![
                job.generation.into(),
                job.lease.into(),
                (DEVICE_FILE_PREVIEW_GEODATA_LEASE_SECONDS as f64).into(),
            ],
        ))
        .await
        .context(h!())?
        .rows_affected()
        == 1)
}

pub(super) async fn publish(
    db: &DatabaseConnection,
    job: &Preview,
    size: i64,
    sha256: Vec<u8>,
) -> Result<bool> {
    let sql=format!("update file_preview p set state='ready',lease=null,lease_until=null,heartbeat_at=null,result_size_bytes=$3,result_sha256=$4,result_encrypted=true,expires_at=now()+make_interval(secs=>$5),cleanup_after=now()+make_interval(secs=>$5),updated_at=now(),error_code=null,retryable=false where {OWNED}");
    Ok(db
        .execute_raw(statement(
            &sql,
            vec![
                job.generation.into(),
                job.lease.into(),
                size.into(),
                sha256.into(),
                (DEVICE_FILE_PREVIEW_GEODATA_READY_TTL_SECONDS as f64).into(),
            ],
        ))
        .await
        .context(h!())?
        .rows_affected()
        == 1)
}

pub(super) async fn fail(
    db: &DatabaseConnection,
    job: &Preview,
    code: &str,
    retryable: bool,
) -> Result<bool> {
    let transaction = db.begin().await.context(h!())?;
    lock_admission(&transaction).await.context(h!())?;
    let result = fail_in_transaction(&transaction, job, code, retryable, true)
        .await
        .context(h!())?;
    transaction.commit().await.context(h!())?;
    Ok(result)
}

async fn fail_in_transaction<C: ConnectionTrait>(
    db: &C,
    job: &Preview,
    code: &str,
    retryable: bool,
    require_live: bool,
) -> Result<bool> {
    let predicate = if require_live {
        OWNED.to_owned()
    } else {
        "p.generation=$1 and p.lease=$2 and p.is_current and p.state='running' and p.lease_until<=now()".to_owned()
    };
    let sql =
        format!("select p.* from file_preview p where {predicate} for update");
    let Some(job) = Preview::find_by_statement(statement(
        &sql,
        vec![job.generation.into(), job.lease.into()],
    ))
    .one(db)
    .await
    .context(h!())?
    else {
        return Ok(false);
    };
    if retryable && job.attempt < 3 && job.source_file_id.is_some() {
        retire(db, job.generation).await.context(h!())?;
        let generation = Uuid::new_v4();
        db.execute_raw(statement("insert into file_preview (generation,device_id,file_id,revision,source_file_id,source_revision,kind,converter_version,is_current,state,run_id,attempt,source_object_key,source_sha256,source_size_bytes,source_is_encrypted,source_name,source_extension,archive_members,not_before,output_object_key,retryable,created_at,updated_at) select $2,device_id,file_id,revision,source_file_id,source_revision,kind,converter_version,true,'retry_wait',run_id,attempt+1,source_object_key,source_sha256,source_size_bytes,source_is_encrypted,source_name,source_extension,archive_members,now()+make_interval(secs=>$4),$3,false,now(),now() from file_preview where generation=$1",vec![job.generation.into(),generation.into(),output_key(job.device_id,job.file_id,job.revision,generation).into(),(DEVICE_FILE_PREVIEW_GEODATA_RETRY_BASE_SECONDS as f64 * job.attempt as f64).into()])).await.context(h!())?;
    } else {
        db.execute_raw(statement("update file_preview set state='failed',lease=null,lease_until=null,heartbeat_at=null,error_code=$2,retryable=$3,updated_at=now(),cleanup_after=greatest(now(),attempt_deadline+make_interval(secs=>$4)) where generation=$1",vec![job.generation.into(),code.into(),retryable.into(),(DEVICE_FILE_PREVIEW_GEODATA_CLEANUP_GRACE_SECONDS as f64).into()])).await.context(h!())?;
    }
    Ok(true)
}

pub(super) async fn cleanup_candidates(
    db: &DatabaseConnection,
) -> Result<Vec<Preview>> {
    db.execute_raw(statement("with expired as (select generation from file_preview where is_current and state='ready' and expires_at<=now() order by expires_at,generation limit $1 for update skip locked) update file_preview p set is_current=false,state='retired',updated_at=now() from expired where p.generation=expired.generation",vec![(DEVICE_FILE_PREVIEW_GEODATA_CLEANUP_BATCH as i64).into()])).await.context(h!())?;
    Preview::find_by_statement(statement("select * from file_preview where cleanup_after<=now() and (not is_current or source_file_id is null or state='failed') and (state<>'running' or lease_until<=now()) order by cleanup_after,generation limit $1",vec![(DEVICE_FILE_PREVIEW_GEODATA_CLEANUP_BATCH as i64).into()])).all(db).await.context(h!())
}

pub(super) async fn cleanup_record(
    db: &DatabaseConnection,
    job: &Preview,
    deleted: bool,
) -> Result<()> {
    if deleted
        && job.object_deleted_at.is_some()
        && job
            .tombstone_until
            .is_some_and(|until| until < chrono::Utc::now())
        && (!job.is_current || job.source_file_id.is_none())
    {
        db.execute_raw(statement("delete from file_preview where generation=$1 and (not is_current or source_file_id is null) and tombstone_until<now()",vec![job.generation.into()])).await.context(h!())?;
    } else if deleted
        && job.object_deleted_at.is_some()
        && job
            .tombstone_until
            .is_some_and(|until| until < chrono::Utc::now())
    {
        db.execute_raw(statement("update file_preview set cleanup_after=null,object_deleted_at=now() where generation=$1 and is_current and state='failed'",vec![job.generation.into()])).await.context(h!())?;
    } else {
        db.execute_raw(statement("update file_preview set cleanup_after=now()+make_interval(secs=>$2),object_deleted_at=case when $3 then now() else object_deleted_at end,tombstone_until=case when $3 then coalesce(tombstone_until,now()+make_interval(secs=>$4)) else tombstone_until end where generation=$1",vec![job.generation.into(),(DEVICE_FILE_PREVIEW_GEODATA_CLEANUP_RETRY_SECONDS as f64).into(),deleted.into(),(DEVICE_FILE_PREVIEW_GEODATA_TOMBSTONE_SECONDS as f64).into()])).await.context(h!())?;
    }
    Ok(())
}
