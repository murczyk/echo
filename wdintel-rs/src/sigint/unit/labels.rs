use super::types::{CreateUnitLabelReq, DeleteUnitLabelReq, UnitLabel};
use crate::entities::{sigint_unit, sigint_unit_label};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::{ensure_rer_role, has_role, login_id_from_identity};
use actix_web::post;
use actix_web::web::{Data, Json};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ActiveValue::Set, ColumnTrait,
    ConnectionTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
    TransactionTrait,
};

pub(crate) fn validate_label(value: &str) -> Result<String, AppError> {
    let label = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.chars().count() < 2 {
        return Err(AppError::BL {
            msg: "Тег підрозділу має містити щонайменше 2 символи".to_string(),
        });
    }
    Ok(label)
}

fn render_label(label: sigint_unit_label::Model) -> UnitLabel {
    UnitLabel {
        id: label.id,
        label: label.label,
    }
}

pub(crate) async fn list_labels<C>(
    db: &C,
    sigint_unit_id: i64,
) -> Result<Vec<UnitLabel>, AppError>
where
    C: ConnectionTrait,
{
    Ok(sigint_unit_label::Entity::find()
        .filter(sigint_unit_label::Column::SigintUnitId.eq(sigint_unit_id))
        .order_by_asc(sigint_unit_label::Column::Label)
        .order_by_asc(sigint_unit_label::Column::Id)
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(render_label)
        .collect())
}

pub(crate) async fn insert_label<C>(
    db: &C,
    sigint_unit_id: i64,
    value: &str,
) -> Result<sigint_unit_label::Model, AppError>
where
    C: ConnectionTrait,
{
    let label = validate_label(value).c(h!())?;
    sigint_unit::Entity::find_by_id(sigint_unit_id)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .filter(sigint_unit::Column::Active.eq(true))
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;

    let existing = sigint_unit_label::Entity::find()
        .filter(Expr::cust_with_values(
            "lower(regexp_replace(btrim(sigint_unit_label.label), '[[:space:]]+', ' ', 'g')) = $1",
            vec![crate::inbox::unit_resolution::normalize_unit_label(&label)],
        ))
        .one(db)
        .await
        .c(h!())?;
    if let Some(existing) = existing {
        if existing.sigint_unit_id == sigint_unit_id {
            return Ok(existing);
        }
        return Err(AppError::BL {
            msg: "Такий тег уже прив'язаний до іншого підрозділу".to_string(),
        });
    }

    sigint_unit_label::ActiveModel {
        id: NotSet,
        created_at: NotSet,
        sigint_unit_id: Set(sigint_unit_id),
        label: Set(label),
    }
    .insert(db)
    .await
    .map_err(|error| {
        if error
            .to_string()
            .contains("sigint_unit_label_normalized_uq")
        {
            AppError::BL {
                msg: "Такий тег уже існує".to_string(),
            }
        } else {
            AppError::from(error)
        }
    })
}

async fn ensure_label_editor(
    db: &DatabaseConnection,
    user: &actix_identity::Identity,
) -> Result<(), AppError> {
    ensure_rer_role(db, user).await.c(h!())?;
    let login = login_id_from_identity(user).c(h!())?;
    has_role(db, &login, "UnitsEditor").await.c(h!())?;
    Ok(())
}

#[post("/api/sigint/unit/label/create")]
pub async fn create_unit_label(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<CreateUnitLabelReq>,
) -> Result<Json<UnitLabel>, AppError> {
    ensure_label_editor(&env.dbx, &user).await.c(h!())?;
    let transaction = env.dbx.begin().await.c(h!())?;
    let label = insert_label(&transaction, req.unit_id, &req.label)
        .await
        .c(h!())?;
    crate::inbox::unit_resolution::mark_failures_pending_for_text(
        &transaction,
        &label.label,
    )
    .await
    .c(h!())?;
    transaction.commit().await.c(h!())?;
    Ok(Json(render_label(label)))
}

#[post("/api/sigint/unit/label/delete")]
pub async fn delete_unit_label(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<DeleteUnitLabelReq>,
) -> Result<Json<()>, AppError> {
    ensure_label_editor(&env.dbx, &user).await.c(h!())?;
    let result = sigint_unit_label::Entity::delete_by_id(req.label_id)
        .exec(&env.dbx)
        .await
        .c(h!())?;
    if result.rows_affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn label_validation_normalizes_whitespace() {
        assert_eq!(
            validate_label("  Власний\n  тег  ").unwrap(),
            "Власний тег"
        );
    }

    #[test]
    fn label_validation_rejects_values_shorter_than_two_characters() {
        assert!(validate_label(" а ").is_err());
        assert!(validate_label(" \n ").is_err());
    }

    #[tokio::test]
    #[serial]
    async fn normalized_labels_are_idempotent_for_one_unit_and_unique_globally()
    {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let first = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let second = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let label = format!("Unique Label {}", uuid::Uuid::new_v4());

        let inserted = insert_label(&env.dbx, first.id, &label).await.unwrap();
        let repeated = insert_label(
            &env.dbx,
            first.id,
            &format!("  {}  ", label.to_uppercase()),
        )
        .await
        .unwrap();
        assert_eq!(repeated.id, inserted.id);

        assert!(matches!(
            insert_label(&env.dbx, second.id, &label.to_lowercase()).await,
            Err(AppError::BL { .. })
        ));
    }
}
