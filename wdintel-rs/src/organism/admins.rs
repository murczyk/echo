use crate::entities::{login, organism_admin};
use crate::h;
use crate::types::{AppError, Context, ShortContext};
use sea_orm::*;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub async fn collect_admin_logins<C: ConnectionTrait>(
    db: &C,
    organism_ids: &[i64],
) -> anyhow::Result<HashMap<i64, Vec<String>>> {
    let rows = organism_admin::Entity::find()
        .filter(
            organism_admin::Column::OrganismId.eq_any(organism_ids.to_vec()),
        )
        .filter(organism_admin::Column::Deleted.eq(false))
        .select_only()
        .column(organism_admin::Column::OrganismId)
        .column(organism_admin::Column::LoginId)
        .order_by_asc(organism_admin::Column::LoginId)
        .into_tuple::<(i64, Uuid)>()
        .all(db)
        .await
        .c(h!())?;
    let mut admins = HashMap::<i64, Vec<String>>::new();
    for (id, login_id) in rows {
        admins.entry(id).or_default().push(login_id.to_string());
    }
    Ok(admins)
}

pub async fn replace_admin_logins(
    db: &DatabaseTransaction,
    organism_id: i64,
    requested: Option<&[String]>,
    scoped: bool,
) -> Result<(), AppError> {
    let Some(requested) = requested else {
        return Ok(());
    };
    let requested = requested
        .iter()
        .map(|id| Uuid::parse_str(id).c(h!()))
        .collect::<anyhow::Result<HashSet<_>>>()
        .c(h!())?;
    let existing = organism_admin::Entity::find()
        .filter(organism_admin::Column::OrganismId.eq(organism_id))
        .filter(organism_admin::Column::Deleted.eq(false))
        .select_only()
        .column(organism_admin::Column::LoginId)
        .into_tuple::<Uuid>()
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .collect::<HashSet<_>>();
    ensure_new_admin_logins(db, organism_id, &requested, &existing, scoped)
        .await
        .context(h!())?;
    organism_admin::Entity::update_many()
        .col_expr(
            organism_admin::Column::Deleted,
            sea_orm::sea_query::Expr::value(true),
        )
        .filter(organism_admin::Column::OrganismId.eq(organism_id))
        .exec(db)
        .await
        .c(h!())?;
    for login_id in requested {
        organism_admin::Entity::insert(organism_admin::ActiveModel {
            organism_id: Set(organism_id),
            login_id: Set(login_id),
            deleted: Set(false),
            ..Default::default()
        })
        .on_conflict(
            sea_orm::sea_query::OnConflict::columns([
                organism_admin::Column::OrganismId,
                organism_admin::Column::LoginId,
            ])
            .update_column(organism_admin::Column::Deleted)
            .to_owned(),
        )
        .exec(db)
        .await
        .c(h!())?;
    }
    Ok(())
}

async fn ensure_new_admin_logins(
    db: &DatabaseTransaction,
    organism_id: i64,
    requested: &HashSet<Uuid>,
    existing: &HashSet<Uuid>,
    scoped: bool,
) -> Result<(), AppError> {
    let added = requested.difference(existing).copied().collect::<Vec<_>>();
    let logins = login::Entity::find()
        .filter(login::Column::Id.eq_any(added.clone()))
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(login::Column::Deleted.eq(false))
        .filter(crate::ai_agent::unmanaged_login_condition())
        .all(db)
        .await
        .c(h!())?;
    if logins.len() != added.len() {
        return Err(AppError::BL {
            msg: "Оберіть активних користувачів для адміністрування організму"
                .into(),
        });
    }
    if scoped {
        for login in &logins {
            if login.organism_id != Some(organism_id) {
                return Err(AppError::Forbidden(
                    "Можна призначати лише користувачів цього організму".into(),
                ));
            }
            let roles: Vec<String> =
                serde_json::from_value(login.roles.clone()).c(h!())?;
            if roles.iter().any(|role| super::access::protected_role(role)) {
                return Err(AppError::Forbidden(
                    "Привілейованими обліковими записами керує Admin".into(),
                ));
            }
        }
    }
    Ok(())
}
