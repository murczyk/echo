use super::types::{CreateUnitLabelReq, DeleteUnitLabelReq, UnitLabel};
use crate::entities::{sigint_unit, sigint_unit_label};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::{
    ensure_admin, ensure_rer_role, has_role, login_id_from_identity,
};
use actix_web::post;
use actix_web::web::{Data, Json};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ActiveValue::Set, ColumnTrait,
    ConnectionTrait, DatabaseConnection, EntityTrait, ModelTrait, QueryFilter,
    QueryOrder, TransactionTrait,
};

pub(crate) fn validate_label(value: &str) -> Result<String, AppError> {
    let label = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if label.chars().count() < 2 {
        return Err(AppError::BL {
            msg: "Синонім підрозділу має містити щонайменше 2 символи"
                .to_string(),
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
            msg: "Такий синонім уже прив'язаний до іншого підрозділу"
                .to_string(),
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
                msg: "Такий синонім уже існує".to_string(),
            }
        } else {
            AppError::from(error)
        }
    })
}

async fn delete_label_and_reprocess<C>(
    db: &C,
    label_id: i64,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let label = sigint_unit_label::Entity::find_by_id(label_id)
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let sigint_unit_id = label.sigint_unit_id;
    crate::stats::enqueue_group_stats_recalculation_for_linked_unit(
        db,
        sigint_unit_id,
        format!("deleted unit label {label_id}"),
    )
    .await
    .c(h!())?;
    label.delete(db).await.c(h!())?;
    crate::inbox::unit_resolution::reprocess_inbox_items_for_unit(
        db,
        sigint_unit_id,
    )
    .await
    .c(h!())?;
    Ok(())
}

async fn ensure_label_editor(
    db: &DatabaseConnection,
    user: &actix_identity::Identity,
) -> Result<(), AppError> {
    ensure_admin(db, user).await.c(h!())?;
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
    let transaction = env.dbx.begin().await.c(h!())?;
    delete_label_and_reprocess(&transaction, req.label_id)
        .await
        .c(h!())?;
    transaction.commit().await.c(h!())?;
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

    #[tokio::test]
    #[serial]
    async fn deleting_a_label_reprocesses_its_inbox_links() {
        let (env, _guard) =
            crate::functest::tests::cleanup_locked().await.unwrap();
        let unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let other_unit = crate::functest::tests::mk_sigint_unit(
            &env.dbx,
            Default::default(),
        )
        .await
        .unwrap();
        let number = chrono::Utc::now().timestamp_micros().unsigned_abs()
            % 7_000_000
            + 1_000_000;
        let label_text = format!("{number} омсбр");
        let other_label_text = format!("{} омсбр", number + 1);
        let label = insert_label(&env.dbx, unit.id, &label_text).await.unwrap();
        insert_label(&env.dbx, other_unit.id, &other_label_text)
            .await
            .unwrap();
        let unit_v2 = format!("{label_text} та {other_label_text}");
        let inbox_item = crate::functest::tests::mk_sigint_inbox_item(
            &env.dbx,
            crate::entities::sigint_inbox_item::ActiveModel {
                unit_v2: Set(Some(unit_v2.clone())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let untouched_inbox_item =
            crate::functest::tests::mk_sigint_inbox_item(
                &env.dbx,
                crate::entities::sigint_inbox_item::ActiveModel {
                    unit_v2: Set(Some(unit_v2)),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        crate::inbox::unit_resolution::resolve_and_sync_inbox_item(
            &env.dbx,
            inbox_item.id,
            inbox_item.unit_v2.as_deref(),
            None,
        )
        .await
        .unwrap();

        delete_label_and_reprocess(&env.dbx, label.id)
            .await
            .unwrap();

        assert!(crate::entities::sigint_inbox_item_unit::Entity::find()
            .filter(
                crate::entities::sigint_inbox_item_unit::Column::ItemId
                    .eq(inbox_item.id),
            )
            .filter(
                crate::entities::sigint_inbox_item_unit::Column::Kind.eq(
                    crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind::Parsed,
                ),
            )
            .filter(
                crate::entities::sigint_inbox_item_unit::Column::UnitId
                    .eq(unit.id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
        assert!(crate::entities::sigint_inbox_item_unit::Entity::find()
            .filter(
                crate::entities::sigint_inbox_item_unit::Column::ItemId
                    .eq(inbox_item.id),
            )
            .filter(
                crate::entities::sigint_inbox_item_unit::Column::Kind.eq(
                    crate::entities::sea_orm_active_enums::SigintInboxItemUnitKind::Parsed,
                ),
            )
            .filter(
                crate::entities::sigint_inbox_item_unit::Column::UnitId
                    .eq(other_unit.id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
        assert!(crate::entities::failed_inbox_unit::Entity::find()
            .filter(
                crate::entities::failed_inbox_unit::Column::InboxItemId
                    .eq(inbox_item.id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_some());
        assert!(crate::entities::failed_inbox_unit::Entity::find()
            .filter(
                crate::entities::failed_inbox_unit::Column::InboxItemId
                    .eq(untouched_inbox_item.id),
            )
            .one(&env.dbx)
            .await
            .unwrap()
            .is_none());
    }
}
