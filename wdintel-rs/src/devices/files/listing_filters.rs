use crate::{
    h,
    types::{Env, ShortContext},
};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::{ConnectionTrait, DbBackend, QueryResult, Statement, Value};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use uuid::Uuid;

#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
)]
#[allow(
    clippy::enum_variant_names,
    reason = "Elm constructors share a module namespace"
)]
pub enum DeviceFileType {
    #[serde(rename = "folder")]
    FileTypeFolder,
    #[serde(rename = "archive")]
    FileTypeArchive,
    #[serde(rename = "image")]
    FileTypeImage,
    #[serde(rename = "audio")]
    FileTypeAudio,
    #[serde(rename = "video")]
    FileTypeVideo,
    #[serde(rename = "document")]
    FileTypeDocument,
    #[serde(rename = "spreadsheet")]
    FileTypeSpreadsheet,
    #[serde(rename = "presentation")]
    FileTypePresentation,
    #[serde(rename = "map")]
    FileTypeMap,
    #[serde(rename = "code")]
    FileTypeCode,
    #[serde(rename = "other")]
    FileTypeOther,
}

#[derive(
    Debug,
    Default,
    Clone,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
)]
#[serde(default, deny_unknown_fields)]
pub struct DeviceFileFilters {
    pub file_types: Vec<DeviceFileType>,
    pub extensions: Vec<String>,
    #[serde(
        deserialize_with = "crate::devices::types::deserialize_optional_datetime"
    )]
    pub modified_from: Option<String>,
    #[serde(
        deserialize_with = "crate::devices::types::deserialize_optional_datetime"
    )]
    pub modified_to: Option<String>,
    pub has_content: Option<bool>,
    pub favorites_only: bool,
    pub unviewed_only: bool,
    pub archive_failed: bool,
    pub archive_encrypted: bool,
    pub tag_ids: Vec<String>,
    pub tag_match: Option<crate::devices::analytics::types::TagMatch>,
    pub untagged: bool,
}

#[derive(
    Debug,
    Clone,
    PartialEq,
    Eq,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
)]
pub struct DeviceFileFilterOptions {
    pub extensions: Vec<String>,
}

impl DeviceFileFilters {
    pub(super) fn validate(&self) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.extensions.len()
                <= crate::devices::config::DEVICE_FILE_FILTER_MAX_VALUES
                && self.tag_ids.len()
                    <= crate::devices::config::DEVICE_FILE_FILTER_MAX_VALUES
                && self.file_types.len()
                    <= crate::devices::config::DEVICE_FILE_FILTER_MAX_VALUES,
            "Too many file filters"
        );
        anyhow::ensure!(
            self.extensions.iter().all(|value| value.len() <= crate::devices::config::DEVICE_FILE_FILTER_EXTENSION_MAX_LENGTH),
            "Invalid extension"
        );
        for tag in &self.tag_ids {
            Uuid::parse_str(tag).c(h!())?;
        }
        if let (Some(from), Some(to)) = (&self.modified_from, &self.modified_to)
        {
            anyhow::ensure!(
                chrono::DateTime::parse_from_rfc3339(from).c(h!())?
                    <= chrono::DateTime::parse_from_rfc3339(to).c(h!())?,
                "Invalid modification date range"
            );
        }
        Ok(())
    }
}

struct FilterQuery {
    values: Vec<Value>,
}

impl FilterQuery {
    fn bind(&mut self, value: impl Into<Value>) -> String {
        self.values.push(value.into());
        format!("${}", self.values.len())
    }

    fn predicate(
        &mut self,
        filters: &DeviceFileFilters,
        login: Uuid,
        snapshot: bool,
    ) -> anyhow::Result<String> {
        let mut clauses = Vec::new();
        clauses.push("child.kind='file'".to_owned());
        if let Some(content) = filters.has_content {
            let content = self.bind(content);
            clauses.push(format!("(child.content_path is not null)={content}"));
        }
        if filters.favorites_only {
            clauses.push("exists(select 1 from file_favorite favorite where favorite.entry_id=child.id)".to_owned());
        }
        if filters.unviewed_only {
            let login = self.bind(login);
            clauses.push(format!("child.kind::text='file' and not exists(select 1 from file_view viewed where viewed.file_id=child.id and viewed.revision=child.revision and viewed.login_id={login})"));
        }
        if filters.archive_failed || filters.archive_encrypted {
            let mut archive = "exists(select 1 from file_archive archive where archive.source_file_id=child.id and archive.source_revision=child.revision".to_owned();
            if filters.archive_failed {
                archive.push_str(" and archive.state='failed'");
            }
            if filters.archive_encrypted {
                archive
                    .push_str(" and archive.error_code='password_protected'");
            }
            archive.push(')');
            clauses.push(archive);
        }
        if !filters.file_types.is_empty() {
            let types = filters
                .file_types
                .iter()
                .map(|kind| {
                    serde_json::to_value(kind)
                        .map(|value| value.as_str().unwrap().to_owned())
                        .c(h!())
                })
                .collect::<anyhow::Result<Vec<_>>>()
                .c(h!())?;
            let types = self.bind(types);
            clauses.push(format!(
                "({})=any({types}::text[])",
                file_type_sql("child")
            ));
        }
        if !filters.extensions.is_empty() {
            let extensions = self.bind(
                filters
                    .extensions
                    .iter()
                    .map(|value| {
                        value.trim().trim_start_matches('.').to_lowercase()
                    })
                    .collect::<Vec<_>>(),
            );
            clauses.push(format!(
                "lower(coalesce(child.extension,''))=any({extensions}::text[])"
            ));
        }
        if let Some(from) = &filters.modified_from {
            let from =
                self.bind(chrono::DateTime::parse_from_rfc3339(from).c(h!())?);
            clauses.push(format!(
                "child.file_metadata_modified_at >= {from}::timestamptz"
            ));
        }
        if let Some(to) = &filters.modified_to {
            let to =
                self.bind(chrono::DateTime::parse_from_rfc3339(to).c(h!())?);
            clauses.push(format!(
                "child.file_metadata_modified_at <= {to}::timestamptz"
            ));
        }
        if snapshot {
            if filters.untagged {
                clauses.push("cardinality(child.tag_ids)=0".to_owned());
            } else if !filters.tag_ids.is_empty() {
                let ids = filters
                    .tag_ids
                    .iter()
                    .map(|id| Uuid::parse_str(id).c(h!()))
                    .collect::<anyhow::Result<Vec<_>>>()
                    .c(h!())?;
                let ids = self.bind(ids);
                let operator = if filters.tag_match
                    == Some(crate::devices::analytics::types::TagMatch::TagAll)
                {
                    "@>"
                } else {
                    "&&"
                };
                clauses.push(format!("child.tag_ids {operator} {ids}::uuid[]"));
            }
        } else {
            self.append_tags(filters, &mut clauses).c(h!())?;
        }
        Ok(clauses.join(" and "))
    }
    fn append_tags(
        &mut self,
        filters: &DeviceFileFilters,
        clauses: &mut Vec<String>,
    ) -> anyhow::Result<()> {
        let tags = "select 1 from device_file_tag membership join analytics_tag tag on tag.id=membership.tag_id and tag.archived_at is null where membership.file_entry_id=child.id";
        if filters.untagged {
            clauses.push(format!("not exists({tags})"));
        } else if !filters.tag_ids.is_empty() {
            let ids = filters
                .tag_ids
                .iter()
                .map(|id| Uuid::parse_str(id).c(h!()))
                .collect::<anyhow::Result<Vec<_>>>()
                .c(h!())?;
            let count = ids.iter().collect::<BTreeSet<_>>().len();
            let ids = self.bind(ids);
            if filters.tag_match
                == Some(crate::devices::analytics::types::TagMatch::TagAll)
            {
                clauses.push(format!("(select count(distinct tag.id) from device_file_tag membership join analytics_tag tag on tag.id=membership.tag_id and tag.archived_at is null where membership.file_entry_id=child.id and tag.id=any({ids}::uuid[]))={count}"));
            } else {
                clauses.push(format!(
                    "exists({tags} and tag.id=any({ids}::uuid[]))"
                ));
            }
        }
        Ok(())
    }
}

fn file_type_sql(alias: &str) -> String {
    let extension = format!("lower(coalesce({alias}.extension,''))");
    let mime =
        format!("lower(split_part(coalesce({alias}.mime_type,''),';',1))");
    format!(
        r#"case
        when {alias}.kind::text='directory' then 'folder'
        when {alias}.is_archive then 'archive'
        when {mime} like 'image/%' then 'image'
        when {mime} like 'audio/%' then 'audio'
        when {mime} like 'video/%' or {mime} in ('application/mp4','application/x-matroska') then 'video'
        when {extension} in ('xls','xlsx','xlsm','xlsb','csv','tsv','ods') or {mime} like '%spreadsheet%' or {mime} like '%excel%' or {mime} in ('text/csv','text/tab-separated-values') then 'spreadsheet'
        when {extension} in ('ppt','pptx','pptm','odp') or {mime} like '%presentation%' or {mime} like '%powerpoint%' then 'presentation'
        when {extension} in ('kml','kmz','gpx','geojson','ldk','trk','are','rte','wpt','set','fit') or {mime} in ('application/vnd.google-earth.kml+xml','application/vnd.google-earth.kmz','application/gpx+xml','application/geo+json','application/vnd.geo+json') then 'map'
        when {extension}='docx' and {mime} in ('application/zip','application/x-zip','application/x-zip-compressed') then 'document'
        when {extension} in ('zip','rar','7z','tar','gz','gzip','tgz','bz2','tbz2','xz','txz','zst') or {mime} in ('application/zip','application/x-zip','application/x-zip-compressed','application/vnd.rar','application/x-rar-compressed','application/x-7z-compressed','application/x-tar','application/gzip','application/x-gzip','application/x-bzip2','application/x-xz','application/zstd') then 'archive'
        when {extension} in ('json','xml','html','htm','css','scss','less','js','ts','jsx','tsx','py','rb','go','rs','c','cpp','h','hpp','cs','java','sh','bash','zsh','ps1','sql','ini','conf','cfg','toml','yaml','yml','env') or {mime} in ('application/json','application/xml','text/xml','text/html','text/css','text/javascript','application/javascript','application/yaml','text/yaml','application/toml') then 'code'
        when {extension} in ('png','jpg','jpeg','gif','webp','bmp','svg','ico','tif','tiff','avif','heic','heif','jfif') then 'image'
        when {extension} in ('mp3','mpga','wav','ogg','oga','opus','m4a','aac','flac','aif','aiff','alac','amr','wma') then 'audio'
        when {extension} in ('mp4','m4v','mov','webm','mkv','avi','mpeg','mpg','wmv','flv','3gp','3g2','m2ts','ogv','vob','asf','f4v') then 'video'
        when {extension} in ('pdf','doc','docx','docm','odt','rtf','txt','md','markdown','log') or {mime} like 'text/%' or {mime} in ('application/pdf','application/msword','application/rtf') or {mime} like '%wordprocessing%' or {mime} like '%ms-word%' or {mime}='application/vnd.oasis.opendocument.text' then 'document'
        else 'other' end"#
    )
}

pub(super) struct ListingFilterScope<'a> {
    pub device: Uuid,
    pub sync: Option<Uuid>,
    pub archive: Option<&'a super::archive::types::DeviceFileContentRef>,
}

pub(super) async fn matching_ids(
    env: &Env,
    login: Uuid,
    scope: ListingFilterScope<'_>,
    ids: Vec<Uuid>,
    filters: &DeviceFileFilters,
    ancestors: bool,
) -> anyhow::Result<BTreeSet<String>> {
    let device = scope.device;
    filters.validate().c(h!())?;
    if ids.is_empty() {
        return Ok(BTreeSet::new());
    }
    let mut query = FilterQuery {
        values: vec![device.into(), ids.into()],
    };
    let predicate = query
        .predicate(filters, login, scope.sync.is_some())
        .c(h!())?;
    let folders = filters.file_types.contains(&DeviceFileType::FileTypeFolder);
    let descendant = if ancestors || folders {
        let predicate = if folders {
            let mut descendants = filters.clone();
            descendants
                .file_types
                .retain(|kind| *kind != DeviceFileType::FileTypeFolder);
            query
                .predicate(&descendants, login, scope.sync.is_some())
                .c(h!())?
        } else {
            predicate.clone()
        };
        format!("or ((candidate.kind='directory' or candidate.is_archive) and exists(select 1 from filter_entries child where child.id<>candidate.id and child.hierarchy_path::ltree <@ candidate.hierarchy_path and {predicate}))")
    } else {
        String::new()
    };
    let sql = format!("select candidate.id from file_entry candidate where candidate.device_id=$1 and candidate.id=any($2::uuid[]) and (exists(select 1 from filter_entries child where child.id=candidate.id and {predicate}) {descendant})");
    let rows = select(env, scope, query, &sql).await.c(h!())?;
    rows.into_iter()
        .map(|row| Ok(row.try_get::<Uuid>("", "id").c(h!())?.to_string()))
        .collect()
}

async fn select(
    env: &Env,
    scope: ListingFilterScope<'_>,
    mut query: FilterQuery,
    sql: &str,
) -> anyhow::Result<Vec<QueryResult>> {
    let db = env.file_registry_db().c(h!())?.connection();
    let ListingFilterScope {
        device,
        sync,
        archive,
    } = scope;
    if let Some(sync) = sync {
        let mut session =
            super::sessions::query::SessionQuery::new(device, vec![sync])
                .include_archives();
        let mut replacements = Vec::new();
        for value in query.values.into_iter().skip(1) {
            replacements.push(session.bind(value));
        }
        let mut sql = sql.replace("filter_entries", "session_entries");
        for index in (0..replacements.len()).rev() {
            sql = sql.replace(
                &format!("${}", index + 2),
                &format!("__FILTER_PARAM_{}__", index),
            );
        }
        for (index, replacement) in replacements.iter().enumerate() {
            sql = sql
                .replace(&format!("__FILTER_PARAM_{}__", index), replacement);
        }
        return session.all(db, &sql).await.c(h!());
    }
    let cte = if let Some(archive) = archive {
        let source = query.bind(archive.file_id);
        let revision = query.bind(archive.revision);
        format!("select entry.id,entry.kind,entry.hierarchy_path,revision.name,revision.extension,revision.mime_type,revision.is_archive,revision.revision,revision.file_metadata_modified_at at time zone 'UTC' as file_metadata_modified_at,content.object_key as content_path from file_revision revision join file_entry entry on entry.id=revision.id join file_archive job on job.id=revision.origin_archive_id and job.state='ready' join file_archive selected on selected.root_id=job.root_id and selected.source_file_id={source} and selected.source_revision={revision} left join file_content content on content.file_id=revision.id and content.revision=revision.revision where entry.device_id=$1")
    } else {
        let visible = super::archive::query::current_visibility_sql("entry");
        format!("select entry.* from file_entry entry where entry.device_id=$1 and {visible}")
    };
    db.query_all_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        format!("with filter_entries as not materialized ({cte}) {sql}"),
        query.values,
    ))
    .await
    .c(h!())
}

pub(super) async fn options(
    env: &Env,
    device: Uuid,
    sync: Option<Uuid>,
) -> anyhow::Result<DeviceFileFilterOptions> {
    let query = FilterQuery {
        values: vec![device.into()],
    };
    let rows = select(env, ListingFilterScope { device, sync, archive: None }, query, "select distinct lower(extension) as extension from filter_entries where kind::text='file' and extension is not null and extension<>'' order by extension").await.c(h!())?;
    Ok(DeviceFileFilterOptions {
        extensions: rows
            .into_iter()
            .map(|row| row.try_get("", "extension").c(h!()))
            .collect::<anyhow::Result<_>>()
            .c(h!())?,
    })
}
