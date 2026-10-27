use super::super::content::repository::PublishedContent;
use crate::{h, types::ShortContext};
use sea_orm::{ConnectionTrait, DbBackend, FromQueryResult, Statement};
use uuid::Uuid;

pub(in crate::devices) async fn find_published_content(
    db: &impl ConnectionTrait,
    device_id: Uuid,
    file_id: Uuid,
    revision: i64,
) -> anyhow::Result<Option<PublishedContent>> {
    PublishedContent::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select entry.name,entry.extension,entry.mime_type,content.object_key,
                content.source_sha256,content.source_size_bytes,content.is_encrypted
         from file_revision entry
         join file_content content on content.file_id=entry.id and content.revision=entry.revision
         where entry.device_id=$1 and entry.id=$2 and entry.revision=$3
           and (entry.origin_archive_id is null or exists(
               select 1 from file_archive archive
               join file_archive root on root.id=archive.root_id and root.device_id=archive.device_id and root.state='ready'
               where archive.id=entry.origin_archive_id and archive.device_id=entry.device_id and archive.state='ready' and content.origin_archive_id=archive.id
                 and (archive.parent_id is null or exists(select 1 from file_archive parent where parent.id=archive.parent_id and parent.device_id=archive.device_id and parent.state='ready'))
           ))",
        [device_id.into(),file_id.into(),revision.into()],
    )).one(db).await.c(h!())
}
