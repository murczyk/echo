use crate::config::{
    PALITRA_GOI_REMOTE_STATUS_PRESENT, PALITRA_GOI_SYNC_DIRECTION_GOI,
};
use crate::entities::*;
use crate::h;
use crate::palitra::types::PalitraChangelogEntry;
use crate::types::*;
use chrono::Utc;
use sea_orm::prelude::Expr;
use sea_orm::*;

#[derive(Debug, FromQueryResult)]
struct GoiPalitraSyncChangelogRow {
    id: i64,
    changelog: serde_json::Value,
}

pub(crate) fn ok_entry(
    text: impl Into<String>,
    description: impl Into<String>,
) -> PalitraChangelogEntry {
    entry(true, text, description)
}

pub(crate) fn error_entry(
    text: impl Into<String>,
    description: impl Into<String>,
) -> PalitraChangelogEntry {
    entry(false, text, description)
}

fn entry(
    is_ok: bool,
    text: impl Into<String>,
    description: impl Into<String>,
) -> PalitraChangelogEntry {
    PalitraChangelogEntry {
        is_ok,
        timestamp: Utc::now().to_rfc3339(),
        text: text.into(),
        description: description.into(),
    }
}

pub(crate) fn entries_from_value(
    value: &serde_json::Value,
) -> Vec<PalitraChangelogEntry> {
    serde_json::from_value(value.clone()).unwrap_or_default()
}

pub(crate) fn latest_entry(
    entries: &[PalitraChangelogEntry],
) -> Option<&PalitraChangelogEntry> {
    entries.last()
}

pub(crate) fn latest_warning(entries: &[PalitraChangelogEntry]) -> bool {
    latest_entry(entries).is_some_and(|entry| !entry.is_ok)
}

pub(crate) fn latest_goi_source_conversion_warning(
    entries: &[PalitraChangelogEntry],
) -> bool {
    latest_entry(entries).is_some_and(|entry| {
        !entry.is_ok && is_goi_source_conversion_failure_text(&entry.text)
    })
}

fn is_goi_source_conversion_failure_text(text: &str) -> bool {
    text == "GOI source conversion failed"
        || text.starts_with("GOI source conversion failed:")
        || text.starts_with("Failed to schedule GOI source conversion:")
        || text.starts_with("Failed to schedule GOI source refresh conversion:")
        || text
            .starts_with("palitra conversion stayed processing for at least ")
}

pub(crate) fn append_to_value(
    value: &serde_json::Value,
    entry: PalitraChangelogEntry,
) -> anyhow::Result<serde_json::Value> {
    let mut entries = entries_from_value(value);
    entries.push(entry);
    serde_json::to_value(entries).c(h!())
}

pub(crate) fn append_to_value_if_latest_differs(
    value: &serde_json::Value,
    entry: PalitraChangelogEntry,
) -> anyhow::Result<serde_json::Value> {
    let mut entries = entries_from_value(value);
    let differs = latest_entry(&entries)
        .map(|latest| {
            latest.is_ok != entry.is_ok
                || latest.text != entry.text
                || latest.description != entry.description
        })
        .unwrap_or(true);
    if differs {
        entries.push(entry);
    }
    serde_json::to_value(entries).c(h!())
}

pub(crate) async fn append_for_palitra_goi_sources<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
    entry: PalitraChangelogEntry,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    let rows = goi_palitra_sync::Entity::find()
        .filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
        .filter(
            goi_palitra_sync::Column::Direction
                .eq(PALITRA_GOI_SYNC_DIRECTION_GOI),
        )
        .filter(
            goi_palitra_sync::Column::RemoteStatus
                .eq(PALITRA_GOI_REMOTE_STATUS_PRESENT),
        )
        .filter(goi_palitra_sync::Column::GoiSourceFileSha256.is_not_null())
        .select_only()
        .column(goi_palitra_sync::Column::Id)
        .column(goi_palitra_sync::Column::Changelog)
        .into_model::<GoiPalitraSyncChangelogRow>()
        .all(dbx)
        .await
        .c(h!())?;
    append_for_rows(dbx, rows, entry).await.c(h!())
}

pub(crate) async fn append_for_palitra_goi_source_file_sha256<'a, C>(
    dbx: &'a C,
    palitra_id: i64,
    file_sha256: &str,
    entry: PalitraChangelogEntry,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    let rows = goi_palitra_sync::Entity::find()
        .filter(goi_palitra_sync::Column::PalitraId.eq(palitra_id))
        .filter(
            goi_palitra_sync::Column::Direction
                .eq(PALITRA_GOI_SYNC_DIRECTION_GOI),
        )
        .filter(
            goi_palitra_sync::Column::RemoteStatus
                .eq(PALITRA_GOI_REMOTE_STATUS_PRESENT),
        )
        .filter(goi_palitra_sync::Column::GoiSourceFileSha256.eq(file_sha256))
        .select_only()
        .column(goi_palitra_sync::Column::Id)
        .column(goi_palitra_sync::Column::Changelog)
        .into_model::<GoiPalitraSyncChangelogRow>()
        .all(dbx)
        .await
        .c(h!())?;
    append_for_rows(dbx, rows, entry).await.c(h!())
}

pub(crate) async fn append_for_palitra_goi_source_row_ids<'a, C>(
    dbx: &'a C,
    row_ids: &[i64],
    entry: PalitraChangelogEntry,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    if row_ids.is_empty() {
        return Ok(());
    }
    let rows = goi_palitra_sync::Entity::find()
        .filter(goi_palitra_sync::Column::Id.is_in(row_ids.to_vec()))
        .select_only()
        .column(goi_palitra_sync::Column::Id)
        .column(goi_palitra_sync::Column::Changelog)
        .into_model::<GoiPalitraSyncChangelogRow>()
        .all(dbx)
        .await
        .c(h!())?;
    append_for_rows(dbx, rows, entry).await.c(h!())
}

async fn append_for_rows<'a, C>(
    dbx: &'a C,
    rows: Vec<GoiPalitraSyncChangelogRow>,
    entry: PalitraChangelogEntry,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'a,
{
    for row in rows {
        let changelog =
            append_to_value_if_latest_differs(&row.changelog, entry.clone())
                .c(h!())?;
        goi_palitra_sync::Entity::update_many()
            .filter(goi_palitra_sync::Column::Id.eq(row.id))
            .col_expr(
                goi_palitra_sync::Column::Changelog,
                Expr::value(changelog),
            )
            .col_expr(
                goi_palitra_sync::Column::UpdatedAt,
                Expr::value(Utc::now().fixed_offset()),
            )
            .exec(dbx)
            .await
            .c(h!())?;
    }
    Ok(())
}
