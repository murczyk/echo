use crate::devices::analytics::types::{TagFilter, TagMatch};
use crate::{h, types::ShortContext};
use sea_orm::{ConnectionTrait, DbBackend, QueryResult, Statement, Value};
use uuid::Uuid;

// A session owns immutable revisions, while file_entry supplies their stable tree identity.
const SESSION_CTES: &str = r#"
with source_revisions as materialized (
    select revision.*, entry.parent_id, entry.hierarchy_path, entry.kind::text as entry_kind, entry.archive_file_id, entry.archive_relative_path,
           entry.created_at as entry_created_at
    from file_revision revision
    join file_entry entry on entry.device_id = revision.device_id and entry.id = revision.id
    where /* source scope */
    /* revision window */
), selected_revisions as materialized (
    select * from source_revisions
    /* derived snapshots */
), latest_results as (
    select distinct on (revision.id, revision.revision)
        revision.id as file_id, revision.revision, item.id, item.result_tag_ids
    from selected_revisions revision
    join file_analysis_run_item item on item.file_id = revision.id and item.completed_at is not null
    join file_revision target on target.id = item.file_id and target.revision = item.metadata_revision
        and target.analysis_input_revision = revision.analysis_input_revision
    join file_analysis_run run on run.id = item.id and run.device_id = $1
    order by revision.id, revision.revision, run.run_sequence desc
), result_tags as materialized (
    select result.result_tag_ids, tags.tag_ids, tags.tags
    from (select distinct result_tag_ids from latest_results) result
    cross join lateral (
        select array_agg(tag.id order by tag.name, tag.id) as tag_ids,
               jsonb_agg(jsonb_build_object('id', tag.id, 'name', tag.name) order by tag.name, tag.id) as tags
        from analytics_tag tag
        where tag.id = any(result.result_tag_ids) and tag.archived_at is null
    ) tags
), session_files as not materialized (
    select revision.id, revision.device_id, revision.parent_id, revision.entry_kind as kind,
           revision.name, revision.absolute_path, revision.hierarchy_path::text,
           revision.mime_type, revision.extension,
           case when revision.entry_kind='directory' then directory_dates.created_at else revision.file_metadata_created_at at time zone 'UTC' end as file_metadata_created_at,
           case when revision.entry_kind='directory' then directory_dates.modified_at else revision.file_metadata_modified_at at time zone 'UTC' end as file_metadata_modified_at,
           revision.entry_created_at as created_at,
           revision.created_at at time zone 'UTC' as updated_at,
           content.object_key as content_path, revision.revision, revision.sync_id,
           revision.source_file_state::text as source_file_state, revision.source_file_state_settled_at,
           revision.source_file_state_settled_by, revision.analysis_input_revision,
           analysis.id as current_analysis_run_id,
           coalesce(tags.tag_ids, '{}'::uuid[]) as tag_ids,
           coalesce(tags.tags, '[]'::jsonb) as tags, revision.is_archive, revision.archive_file_id, revision.archive_relative_path,
           case when revision.entry_kind='directory' then /* archive directory size */ else content.source_size_bytes end as size_bytes
    from selected_revisions revision
    left join lateral (/* archive directory dates */) directory_dates on true
    left join file_content content on content.file_id = revision.id and content.revision = revision.revision
    left join latest_results analysis on analysis.file_id = revision.id and analysis.revision = revision.revision
    left join result_tags tags on tags.result_tag_ids = analysis.result_tag_ids
), session_entries as (
    select * from session_files
    union all
    select entry.id, entry.device_id, entry.parent_id, entry.kind::text, entry.name,
           entry.absolute_path, entry.hierarchy_path::text, entry.mime_type, entry.extension,
           ancestors.created_at, ancestors.modified_at,
           entry.created_at, entry.updated_at, entry.content_path, entry.revision, entry.sync_id,
           entry.source_file_state::text, entry.source_file_state_settled_at, entry.source_file_state_settled_by,
           entry.analysis_input_revision, entry.current_analysis_run_id, '{}'::uuid[], '[]'::jsonb, entry.is_archive, entry.archive_file_id, entry.archive_relative_path, ancestors.size_bytes
    from (
        select subpath(revision.hierarchy_path, 0, depth) as hierarchy_path,
               min(revision.file_metadata_created_at) at time zone 'UTC' as created_at,
               max(revision.file_metadata_modified_at) at time zone 'UTC' as modified_at,
               coalesce(sum(content.source_size_bytes),0)::bigint as size_bytes
        from selected_revisions revision
        left join file_content content on content.file_id=revision.id and content.revision=revision.revision
        cross join lateral generate_series(1, nlevel(revision.hierarchy_path) - 1) levels(depth)
        where revision.entry_kind='file' and revision.archive_file_id is null
        group by subpath(revision.hierarchy_path, 0, depth)
    ) ancestors
    join file_entry entry on entry.device_id = $1 and entry.hierarchy_path = ancestors.hierarchy_path
    where entry.kind = 'directory' and entry.archive_file_id is null
)
"#;

pub(in crate::devices::files) struct SessionQuery {
    values: Vec<Value>,
    revision_window: String,
    single_session: bool,
    include_archives: bool,
    archive_snapshot: bool,
}

impl SessionQuery {
    pub(in crate::devices::files) fn new(
        device_id: Uuid,
        sync_ids: Vec<Uuid>,
    ) -> Self {
        Self {
            single_session: sync_ids.len() == 1,
            include_archives: false,
            archive_snapshot: false,
            values: vec![device_id.into(), sync_ids.into()],
            revision_window: String::new(),
        }
    }

    pub(in crate::devices::files) fn archive(
        device_id: Uuid,
        root: Uuid,
    ) -> Self {
        Self {
            values: vec![device_id.into(), root.into()],
            revision_window: String::new(),
            single_session: false,
            include_archives: false,
            archive_snapshot: true,
        }
    }

    pub(in crate::devices::files) fn include_archives(mut self) -> Self {
        self.include_archives = true;
        self
    }

    pub(in crate::devices::files) fn bind(
        &mut self,
        value: impl Into<Value>,
    ) -> String {
        self.values.push(value.into());
        format!("${}", self.values.len())
    }

    pub(in crate::devices::files) fn journal_page(
        &mut self,
        after: Option<(chrono::NaiveDateTime, Uuid)>,
        limit: u64,
    ) {
        let predicate = after
            .map(|(time, id)| {
                let time = self.bind(time.and_utc());
                let id = self.bind(id);
                format!(
                    "and (revision.created_at, revision.id) < ({time}, {id})"
                )
            })
            .unwrap_or_default();
        let cap = self.bind((limit + 1) as i64);
        self.revision_window = format!("{predicate} order by revision.created_at desc, revision.id desc limit {cap}");
    }

    pub(in crate::devices::files) fn tag_filter(
        &mut self,
        alias: &str,
        filter: Option<&TagFilter>,
    ) -> String {
        match filter {
            None => "true".to_owned(),
            Some(filter) if filter.untagged => {
                format!("cardinality({alias}.tag_ids) = 0")
            }
            Some(filter) => {
                let ids = self.bind(filter.tag_ids.clone());
                let operator = match filter.tag_match {
                    TagMatch::TagAny => "&&",
                    TagMatch::TagAll => "@>",
                };
                format!("{alias}.tag_ids {operator} {ids}::uuid[]")
            }
        }
    }

    pub(in crate::devices::files) async fn all(
        self,
        db: &impl ConnectionTrait,
        sql: &str,
    ) -> anyhow::Result<Vec<QueryResult>> {
        let derived = if self.include_archives {
            r#"union all
    select revision.*,entry.parent_id,entry.hierarchy_path,entry.kind::text,entry.archive_file_id,entry.archive_relative_path,entry.created_at
    from file_revision revision join file_entry entry on entry.id=revision.id
    join file_archive job on job.id=revision.origin_archive_id and job.state='ready'
    join file_archive root on root.id=job.root_id and root.state='ready'
    join source_revisions source on source.id=root.source_file_id and source.revision=root.source_revision
        and not exists(select 1 from source_revisions newer where newer.id=source.id and newer.sync_id=source.sync_id and newer.revision>source.revision)
    where revision.device_id=$1"#
        } else {
            ""
        };
        let directory_dates =
            crate::devices::files::query::dates::aggregate_sql("revision");
        let directory_dates = format!("select dates.* from ({directory_dates}) dates where revision.entry_kind='directory'");
        let directory_size =
            crate::devices::files::query::sizes::directory_value_sql(
                "revision",
                "revision.revision",
            );
        let source = if self.archive_snapshot {
            "revision.device_id=$1 and revision.origin_archive_id in (select id from file_archive where root_id=$2 and state='ready')"
        } else {
            "revision.origin_archive_id is null and entry.archive_file_id is null and revision.device_id = $1 and revision.sync_id = any($2::uuid[])"
        };
        let ctes = SESSION_CTES
            .replace("/* source scope */", source)
            .replace("/* archive directory size */", &directory_size)
            .replace("/* archive directory dates */", &directory_dates)
            .replace("/* revision window */", &self.revision_window)
            .replace("/* derived snapshots */", derived);
        let ctes = if self.single_session {
            ctes.replace(
                "revision.sync_id = any($2::uuid[])",
                "revision.sync_id = ($2::uuid[])[1]",
            )
        } else {
            ctes
        };
        db.query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!("{ctes}{sql}"),
            self.values,
        ))
        .await
        .c(h!())
    }
}
