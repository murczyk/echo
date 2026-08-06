use crate::entities::sea_orm_active_enums::SigintInboxItemCallsignSource;
use crate::entities::sigint_inbox_item_callsign;
use crate::error::AppError;
use crate::h;
use crate::types::ShortContext;
use chrono::Utc;
use sea_orm::prelude::Expr;
use sea_orm::*;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

#[derive(Clone, Copy)]
pub(crate) enum EffectiveCallsignSqlSource {
    Postgres,
    Analytics,
}

pub(crate) fn postgres_effective_callsign_ctes(
    filtered_items_sql: &str,
) -> String {
    format!(
        r#"
WITH filtered_items AS ({filtered_items_sql})
, normalized_callsigns AS (
    SELECT DISTINCT
        callsign.sigint_inbox_item_id AS inbox_item_id,
        callsign.callsign
    FROM sigint_inbox_item_callsign AS callsign
    INNER JOIN filtered_items
        ON filtered_items.id = callsign.sigint_inbox_item_id
    WHERE NOT callsign.deleted
)
, all_callsigns AS (
    SELECT inbox_item_id, callsign FROM normalized_callsigns
)
"#,
        filtered_items_sql = filtered_items_sql,
    )
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct InboxItemCallsigns {
    pub primary: Vec<String>,
    pub alg2: Vec<String>,
}

impl InboxItemCallsigns {
    fn normalized(mut self) -> Self {
        self.primary = crate::utils::uniq_via_btreeset(&self.primary);
        self.alg2 = crate::utils::uniq_via_btreeset(&self.alg2);
        self
    }

    pub fn effective(&self) -> Vec<String> {
        crate::utils::uniq_via_btreeset(
            &self
                .primary
                .iter()
                .chain(self.alg2.iter())
                .cloned()
                .collect::<Vec<_>>(),
        )
    }
}

pub fn sql_filter_condition(selected_callsigns: &[String]) -> String {
    let selected_callsigns = sql_string_literals(selected_callsigns);
    format!("exists (select 1 from sigint_inbox_item_callsign siic where siic.sigint_inbox_item_id = sigint_inbox_item.id and not siic.deleted and siic.callsign in ({selected_callsigns}))")
}

pub(crate) fn sql_string_literals(values: &[String]) -> String {
    values
        .iter()
        .map(|callsign| format!("'{}'", callsign.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn sql_exists_condition(inbox_alias: &str) -> String {
    format!("exists (select 1 from sigint_inbox_item_callsign siic where siic.sigint_inbox_item_id = {inbox_alias}.id and not siic.deleted)")
}

pub async fn sync<C>(
    dbx: &C,
    sigint_inbox_item_id: i64,
    callsigns: InboxItemCallsigns,
    actor_id: Uuid,
) -> Result<InboxItemCallsigns, AppError>
where
    C: ConnectionTrait,
{
    let callsigns = callsigns.normalized();
    lock_parent(dbx, sigint_inbox_item_id).await?;
    let existing = sigint_inbox_item_callsign::Entity::find()
        .filter(
            sigint_inbox_item_callsign::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .all(dbx)
        .await
        .c(h!())?;

    sync_source(
        dbx,
        actor_id,
        sigint_inbox_item_id,
        SigintInboxItemCallsignSource::Primary,
        &callsigns.primary,
        &existing,
    )
    .await?;
    sync_source(
        dbx,
        actor_id,
        sigint_inbox_item_id,
        SigintInboxItemCallsignSource::Alg2,
        &callsigns.alg2,
        &existing,
    )
    .await?;
    Ok(callsigns)
}

pub async fn load_by_item_ids<C>(
    dbx: &C,
    item_ids: &[i64],
) -> Result<HashMap<i64, InboxItemCallsigns>, AppError>
where
    C: ConnectionTrait,
{
    if item_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let item_ids = crate::utils::uniq_via_btreeset(item_ids);
    let mut result = HashMap::new();
    for item_ids in
        item_ids.chunks(crate::config::INBOX_ITEM_CALLSIGN_LOAD_BATCH_SIZE)
    {
        let rows = sigint_inbox_item_callsign::Entity::find()
            .filter(
                sigint_inbox_item_callsign::Column::SigintInboxItemId
                    .is_in(item_ids.to_vec()),
            )
            .filter(sigint_inbox_item_callsign::Column::Deleted.eq(false))
            .order_by_asc(sigint_inbox_item_callsign::Column::SigintInboxItemId)
            .order_by_asc(sigint_inbox_item_callsign::Column::Source)
            .order_by_asc(sigint_inbox_item_callsign::Column::Ordering)
            .order_by_asc(sigint_inbox_item_callsign::Column::Id)
            .all(dbx)
            .await
            .c(h!())?;
        for row in rows {
            let callsigns: &mut InboxItemCallsigns =
                result.entry(row.sigint_inbox_item_id).or_default();
            match row.source {
                SigintInboxItemCallsignSource::Primary => {
                    callsigns.primary.push(row.callsign)
                }
                SigintInboxItemCallsignSource::Alg2 => {
                    callsigns.alg2.push(row.callsign)
                }
            }
        }
    }
    Ok(result)
}

async fn lock_parent<C>(
    dbx: &C,
    sigint_inbox_item_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let row = dbx
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "select id from sigint_inbox_item where id = $1 for update",
            [sigint_inbox_item_id.into()],
        ))
        .await
        .c(h!())?;
    if row.is_none() {
        return Err(AppError::NotFound);
    }
    Ok(())
}

async fn sync_source<C>(
    dbx: &C,
    actor_id: Uuid,
    sigint_inbox_item_id: i64,
    source: SigintInboxItemCallsignSource,
    desired: &[String],
    existing: &[sigint_inbox_item_callsign::Model],
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let desired_callsigns = desired.iter().collect::<HashSet<_>>();
    let missing_ids = existing
        .iter()
        .filter(|row| {
            row.source == source
                && !row.deleted
                && !desired_callsigns.contains(&row.callsign)
        })
        .map(|row| row.id)
        .collect::<Vec<_>>();
    if !missing_ids.is_empty() {
        sigint_inbox_item_callsign::Entity::update_many()
            .col_expr(
                sigint_inbox_item_callsign::Column::Deleted,
                Expr::value(true),
            )
            .col_expr(
                sigint_inbox_item_callsign::Column::DeletedAt,
                Expr::value(Utc::now().naive_utc()),
            )
            .col_expr(
                sigint_inbox_item_callsign::Column::DeletedById,
                Expr::value(actor_id),
            )
            .filter(sigint_inbox_item_callsign::Column::Id.is_in(missing_ids))
            .exec(dbx)
            .await
            .c(h!())?;
    }

    for (ordering, callsign) in desired.iter().cloned().enumerate() {
        let ordering = ordering as f64;
        let existing = existing
            .iter()
            .find(|row| row.source == source && row.callsign == callsign);
        if let Some(existing) = existing {
            if !existing.deleted && existing.ordering == ordering {
                continue;
            }
            let mut existing = existing.clone().into_active_model();
            if existing.ordering.as_ref() != &ordering {
                existing.ordering = Set(ordering);
            }
            if *existing.deleted.as_ref() {
                existing.deleted = Set(false);
                existing.deleted_at = Set(None);
                existing.deleted_by_id = Set(None);
            }
            existing.update(dbx).await.c(h!())?;
        } else {
            sigint_inbox_item_callsign::ActiveModel {
                id: NotSet,
                sigint_inbox_item_id: Set(sigint_inbox_item_id),
                callsign: Set(callsign),
                source: Set(source.clone()),
                ordering: Set(ordering),
                created_at: NotSet,
                deleted_at: Set(None),
                deleted: Set(false),
                created_by_id: Set(actor_id),
                deleted_by_id: Set(None),
            }
            .insert(dbx)
            .await
            .c(h!())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_callsigns_prefer_primary_order() {
        let callsigns = InboxItemCallsigns {
            primary: vec!["alpha".into(), "bravo".into()],
            alg2: vec!["bravo".into(), "charlie".into()],
        };
        assert_eq!(callsigns.effective(), vec!["alpha", "bravo", "charlie"]);
    }

    #[test]
    fn callsign_filter_escapes_sql_literals() {
        let condition = sql_filter_condition(&["call'sign".to_string()]);
        assert!(condition.contains("'call''sign'"));
        assert_eq!(condition.matches("and not siic.deleted").count(), 1);
        assert!(condition.contains("sigint_inbox_item_callsign"));
    }

    #[test]
    fn callsign_existence_fallback_requires_no_normalized_rows() {
        let condition = sql_exists_condition("sigint_inbox_item");
        assert!(condition.contains("not exists"));
        assert_eq!(condition.matches("and not siic.deleted").count(), 1);
    }
}
