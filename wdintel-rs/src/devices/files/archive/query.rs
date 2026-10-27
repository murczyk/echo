use super::types::*;
use crate::{
    devices::config::*, file_registry::entities::file_archive, h,
    types::ShortContext,
};
use anyhow::{Context, Result};
use sea_orm::{ConnectionTrait, DbBackend, FromQueryResult, Statement};
use std::collections::BTreeMap;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub(in crate::devices::files) struct Rejection(pub &'static str);

#[derive(FromQueryResult)]
pub(super) struct Source {
    pub name: String,
    pub extension: Option<String>,
    pub mime_type: Option<String>,
    pub has_content: bool,
}

pub(super) async fn source(
    db: &impl ConnectionTrait,
    target: &DeviceFileContentRef,
) -> Result<Source> {
    if target.revision <= 0 {
        return Err(Rejection("invalid_request").into());
    }
    let source = Source::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select r.name,r.extension,r.mime_type,exists(select 1 from file_content c where c.file_id=r.id and c.revision=r.revision) as has_content
         from file_revision r join file_entry e on e.id=r.id and e.kind='file' where r.device_id=$1 and r.id=$2 and r.revision=$3
           and (r.origin_archive_id is null or exists(select 1 from file_archive a where a.id=r.origin_archive_id and a.device_id=r.device_id and a.state='ready'))",
        [target.device_id.into(),target.file_id.into(),target.revision.into()])).one(db).await.c(h!())?.ok_or(Rejection("not_found")).context(h!())?;
    if !super::super::preview::is_archive(
        &source.name,
        source.extension.as_deref(),
        source.mime_type.as_deref(),
    ) {
        return Err(Rejection("unsupported_format").into());
    }
    if source.has_content
        && super::access::find_published_content(
            db,
            target.device_id,
            target.file_id,
            target.revision,
        )
        .await
        .context(h!())?
        .is_none()
    {
        return Err(Rejection("not_found").into());
    }
    Ok(source)
}

pub(super) async fn archive(
    db: &impl ConnectionTrait,
    target: &DeviceFileContentRef,
) -> Result<Option<file_archive::Model>> {
    file_archive::Model::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select * from file_archive where device_id=$1 and source_file_id=$2 and source_revision=$3",
        [target.device_id.into(), target.file_id.into(), target.revision.into()])).one(db).await.c(h!())
}

pub(super) async fn status(
    db: &impl ConnectionTrait,
    target: DeviceFileContentRef,
) -> Result<DeviceArchiveStatus> {
    let source = source(db, &target).await.context(h!())?;
    let archive = archive(db, &target).await.context(h!())?;
    Ok(DeviceArchiveStatus {
        archive: summary(archive.as_ref(), source.has_content).context(h!())?,
        source: target,
        next_attempt_at: archive
            .as_ref()
            .filter(|a| a.state == "retry_wait")
            .map(|a| a.not_before.to_rfc3339()),
        poll_after_ms: DEVICE_FILE_ARCHIVE_POLL_MILLIS as i64,
        updated_at: archive.as_ref().map(|a| a.updated_at.to_rfc3339()),
    })
}

pub(super) fn summary(
    archive: Option<&file_archive::Model>,
    has_content: bool,
) -> Result<DeviceArchiveSummary> {
    let state = match archive {
        Some(archive) => serde_json::from_value(serde_json::Value::String(
            archive.state.clone(),
        ))
        .c(h!())?,
        None if has_content => DeviceArchiveState::ArchiveNotPrepared,
        None => DeviceArchiveState::ArchiveMissingContent,
    };
    let reason = archive
        .and_then(|a| a.error_code.as_ref())
        .map(|code| {
            serde_json::from_value(serde_json::Value::String(code.clone()))
        })
        .transpose()
        .c(h!())?;
    Ok(DeviceArchiveSummary {
        archive_id: archive.map(|a| a.id),
        root_entry_id: archive
            .filter(|a| a.state == "ready")
            .map(|a| a.source_file_id),
        state,
        message: archive
            .and_then(|a| a.error_code.as_deref())
            .map(message)
            .map(str::to_owned),
        reason,
        limit_name: archive.and_then(|a| a.exhausted_limit.clone()),
    })
}

fn message(reason: &str) -> &'static str {
    match reason {
        "password_protected" => "Архів захищений паролем",
        "safety_limit" => {
            "Розпакування зупинено: перевищено ліміти безпеки архіву"
        }
        "invalid_archive" => "Архів пошкоджено",
        "unsupported_format" => "Формат архіву не підтримується",
        "source_too_large" => "Архів перевищує дозволений розмір",
        "unsafe_path" => "Архів містить небезпечний шлях",
        "path_conflict" => "Архів містить неоднозначні імена файлів",
        "integrity_mismatch" => "Перевірка цілісності архіву не пройдена",
        "retry_exhausted" => {
            "Не вдалося підготувати архів після повторних спроб"
        }
        "storage_unavailable" => "Сховище архіву недоступне",
        _ => "Не вдалося підготувати архів",
    }
}

pub(in crate::devices::files) async fn summaries(
    db: &impl ConnectionTrait,
    device: Uuid,
    targets: &[(Uuid, i64)],
) -> Result<BTreeMap<(Uuid, i64), DeviceArchiveSummary>> {
    if targets.is_empty() {
        return Ok(BTreeMap::new());
    }
    let identities = serde_json::Value::Array(targets.iter().map(|(id, revision)| serde_json::json!({"id":id,"revision":revision})).collect());
    let archives = file_archive::Model::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
        "select a.* from file_archive a join jsonb_to_recordset($2) as wanted(id uuid,revision bigint)
         on a.source_file_id=wanted.id and a.source_revision=wanted.revision where a.device_id=$1",
        [device.into(),identities.clone().into()])).all(db).await.c(h!())?
        .into_iter().map(|archive| ((archive.source_file_id,archive.source_revision),archive)).collect::<BTreeMap<_,_>>();
    let rows = db.query_all_raw(Statement::from_sql_and_values(DbBackend::Postgres,
        "select r.id,r.revision,r.name,r.extension,r.mime_type,c.file_id is not null as has_content
         from jsonb_to_recordset($2) as wanted(id uuid,revision bigint)
         join file_revision r on r.id=wanted.id and r.revision=wanted.revision and r.device_id=$1
         join file_entry entry on entry.id=r.id and entry.kind='file'
         left join file_content c on c.file_id=r.id and c.revision=r.revision",
        [device.into(),identities.into()])).await.c(h!())?;
    let mut result = BTreeMap::new();
    for row in rows {
        let name = row.try_get::<String>("", "name").c(h!())?;
        let extension =
            row.try_get::<Option<String>>("", "extension").c(h!())?;
        let mime = row.try_get::<Option<String>>("", "mime_type").c(h!())?;
        if !super::super::preview::is_archive(
            &name,
            extension.as_deref(),
            mime.as_deref(),
        ) {
            continue;
        }
        let target = (
            row.try_get("", "id").c(h!())?,
            row.try_get("", "revision").c(h!())?,
        );
        result.insert(
            target,
            summary(
                archives.get(&target),
                row.try_get("", "has_content").c(h!())?,
            )
            .context(h!())?,
        );
    }
    Ok(result)
}

pub(in crate::devices::files) fn current_visibility(
) -> sea_orm::sea_query::SimpleExpr {
    current_visibility_for("file_entry")
}

pub(in crate::devices::files) fn current_visibility_for(
    alias: &str,
) -> sea_orm::sea_query::SimpleExpr {
    sea_orm::sea_query::Expr::cust(format!("({alias}.archive_file_id is null or exists(select 1 from file_revision visible join file_archive job on job.id=visible.origin_archive_id and job.state='ready' join file_archive root on root.id=job.root_id and root.state='ready' join file_entry source on source.id=root.source_file_id and source.revision=root.source_revision where visible.id={alias}.id and visible.revision={alias}.revision))"))
}
