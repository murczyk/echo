use super::types::{
    UnitChangelogChange, UnitChangelogEntry, UnitChangelogRsp, UnitDetailsReq,
};
use crate::config::SIGINT_UNIT_CHANGELOG_LIMIT;
use crate::entities::sigint_unit;
use crate::error::AppError;
use crate::types::*;
use crate::users::{ensure_rer_role, login_id_from_identity};
use actix_web::post;
use actix_web::web::{Data, Json};
use chrono::NaiveDateTime;
use sea_orm::{
    ColumnTrait, ConnectionTrait, DbBackend, EntityTrait, FromQueryResult,
    JsonValue, QueryFilter, Statement,
};
use serde_json::Value;
use uuid::Uuid;

const UNIT_FIELDS: &[&str] = &[
    "name",
    "other",
    "team_or_crew",
    "section",
    "squad",
    "platoon",
    "company",
    "battalion",
    "regiment",
    "brigade",
    "division",
    "corps",
    "army",
    "military_district",
    "army_region",
    "active",
    "comment",
    "orbit_note",
    "is_deduplicate_candidate",
    "is_inconsistent",
    "deleted",
];

#[derive(FromQueryResult)]
struct UnitChangelogRow {
    id: i64,
    kind: String,
    created_at: NaiveDateTime,
    author: String,
    old_value: Option<JsonValue>,
    new_value: Option<JsonValue>,
}

pub(crate) async fn set_author<C>(dbx: &C, login: &Uuid) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    dbx.execute_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select set_config('echo.sigint_unit_change_author_id', $1, true)",
        [login.to_string().into()],
    ))
    .await
    .c(h!())?;
    Ok(())
}

#[post("/api/sigint/unit/changelog")]
pub async fn unit_changelog(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<UnitDetailsReq>,
) -> Result<Json<UnitChangelogRsp>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.c(h!())?;
    let login = login_id_from_identity(&user).c(h!())?;
    let can_view_orbit = super::orbit::can_view_orbit_data(&env.dbx, &login)
        .await
        .c(h!())?;
    sigint_unit::Entity::find_by_id(req.unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .one(&env.dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;

    let rows =
        UnitChangelogRow::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
select unit_change.id,
       unit_change.kind,
       unit_change.created_at,
       login.login as author,
       unit_change.old_value,
       unit_change.new_value
from sigint_unit_change unit_change
join login on login.id = unit_change.author_login_id
where unit_change.sigint_unit_id = $1
  and unit_change.old_value is distinct from unit_change.new_value
order by unit_change.created_at desc, unit_change.id desc
limit $2
            "#,
            [req.unit_id.into(), SIGINT_UNIT_CHANGELOG_LIMIT.into()],
        ))
        .all(&env.dbx)
        .await
        .c(h!())?;

    Ok(Json(UnitChangelogRsp {
        entries: rows
            .into_iter()
            .filter_map(|row| render_entry(row, can_view_orbit))
            .collect(),
    }))
}

fn render_entry(
    row: UnitChangelogRow,
    can_view_orbit: bool,
) -> Option<UnitChangelogEntry> {
    if row.kind == "orbit_links" && !can_view_orbit {
        return None;
    }
    let action = entry_action(&row);
    let changes = if row.kind == "orbit_links" {
        vec![UnitChangelogChange {
            field: "orbit_units".to_string(),
            old_value: orbit_links_value(row.old_value.as_ref()),
            new_value: orbit_links_value(row.new_value.as_ref()),
        }]
    } else {
        unit_changes(
            row.old_value.as_ref(),
            row.new_value.as_ref(),
            can_view_orbit,
        )
    };
    if changes.is_empty() {
        return None;
    }
    Some(UnitChangelogEntry {
        id: row.id,
        author: row.author,
        created_at: row.created_at.and_utc().timestamp_millis(),
        action,
        changes,
    })
}

fn entry_action(row: &UnitChangelogRow) -> String {
    if row.kind == "orbit_links" {
        return "orbit_links".to_string();
    }
    if row.old_value.is_none() {
        return "create".to_string();
    }
    if row.new_value.is_none()
        || (json_field(row.old_value.as_ref(), "deleted")
            != Some(&Value::Bool(true))
            && json_field(row.new_value.as_ref(), "deleted")
                == Some(&Value::Bool(true)))
    {
        return "delete".to_string();
    }
    "update".to_string()
}

fn unit_changes(
    old_value: Option<&JsonValue>,
    new_value: Option<&JsonValue>,
    can_view_orbit: bool,
) -> Vec<UnitChangelogChange> {
    UNIT_FIELDS
        .iter()
        .filter(|field| {
            can_view_orbit
                || !matches!(**field, "orbit_note" | "is_deduplicate_candidate")
        })
        .filter_map(|field| {
            let old_value = json_field(old_value, field);
            let new_value = json_field(new_value, field);
            (old_value != new_value).then(|| UnitChangelogChange {
                field: (*field).to_string(),
                old_value: display_value(old_value),
                new_value: display_value(new_value),
            })
        })
        .collect()
}

fn json_field<'a>(
    value: Option<&'a JsonValue>,
    field: &str,
) -> Option<&'a Value> {
    value
        .and_then(Value::as_object)
        .and_then(|value| value.get(field))
}

fn display_value(value: Option<&Value>) -> Option<String> {
    match value {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) if value.trim().is_empty() => None,
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        Some(value) => Some(value.to_string()),
    }
}

fn orbit_links_value(value: Option<&JsonValue>) -> Option<String> {
    let links = value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|link| {
            let link = link.as_object()?;
            let id = link.get("id")?.as_str()?;
            let name = link.get("name").and_then(Value::as_str).unwrap_or(id);
            Some(if name == id {
                id.to_string()
            } else {
                format!("{name} ({id})")
            })
        })
        .collect::<Vec<_>>();
    (!links.is_empty()).then(|| links.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_orbit_fields_are_removed_from_unit_changes() {
        let old_value = serde_json::json!({
            "name": "unit",
            "orbit_note": "old",
            "is_deduplicate_candidate": false
        });
        let new_value = serde_json::json!({
            "name": "unit",
            "orbit_note": "new",
            "is_deduplicate_candidate": true
        });

        assert!(
            unit_changes(Some(&old_value), Some(&new_value), false).is_empty()
        );
        assert_eq!(
            unit_changes(Some(&old_value), Some(&new_value), true).len(),
            2
        );
    }
}
