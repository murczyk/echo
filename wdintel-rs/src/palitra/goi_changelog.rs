use crate::entities::*;
use crate::h;
use crate::palitra::types::PalitraChangelogEntry;
use crate::types::*;
use chrono::Utc;
use sea_orm::prelude::Expr;
use sea_orm::*;

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
        .filter(goi_palitra_sync::Column::GoiSourceFileSha256.is_not_null())
        .all(dbx)
        .await
        .c(h!())?;

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
