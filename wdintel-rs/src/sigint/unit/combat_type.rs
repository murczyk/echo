use super::types::{ListUnitsReq, Unit, UnitCombatType, UnitCombatTypesRsp};
use crate::entities::{sigint_unit, sigint_unit_orbit_combat_type};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use crate::users::{has_any_role, login_id_from_identity};
use actix_web::{
    post,
    web::{Data, Json},
};
use sea_orm::{
    sea_query::{Expr, SimpleExpr},
    ColumnTrait, ConnectionTrait, EntityTrait, ExprTrait, FromQueryResult,
    Order, QueryFilter, QueryOrder, QuerySelect, Select,
};
use std::collections::HashMap;
use uuid::Uuid;

#[post("/api/sigint/unit/combat-types")]
pub async fn list_combat_types(
    user: actix_identity::Identity,
    env: Data<Env>,
) -> Result<Json<UnitCombatTypesRsp>, AppError> {
    let login = login_id_from_identity(&user).c(h!())?;
    has_any_role(&env.dbx, &login, vec!["Rer", "Cyber", "Api"])
        .await
        .c(h!())?;
    let combat_types = sigint_unit_orbit_combat_type::Entity::find()
        .order_by_asc(sigint_unit_orbit_combat_type::Column::Name)
        .order_by_asc(sigint_unit_orbit_combat_type::Column::Id)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|combat_type| UnitCombatType {
            id: combat_type.id.to_string(),
            name: combat_type.name,
        })
        .collect();
    Ok(Json(UnitCombatTypesRsp { combat_types }))
}

pub(super) async fn validate_id<C>(
    db: &C,
    id: Option<&str>,
) -> anyhow::Result<Option<Uuid>>
where
    C: ConnectionTrait,
{
    let Some(id) = id else {
        return Ok(None);
    };
    let id = Uuid::parse_str(id).c(h!())?;
    sigint_unit_orbit_combat_type::Entity::find_by_id(id)
        .one(db)
        .await
        .c(h!())?
        .c(h!())?;
    Ok(Some(id))
}

pub(super) async fn populate_names<C>(
    db: &C,
    units: &mut [Unit],
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let ids = units
        .iter()
        .filter_map(|unit| unit.combat_type_id.as_deref())
        .map(Uuid::parse_str)
        .collect::<Result<Vec<_>, _>>()
        .c(h!())?;
    if ids.is_empty() {
        return Ok(());
    }
    let names = sigint_unit_orbit_combat_type::Entity::find()
        .filter(sigint_unit_orbit_combat_type::Column::Id.is_in(ids))
        .all(db)
        .await
        .c(h!())?
        .into_iter()
        .map(|combat_type| (combat_type.id.to_string(), combat_type.name))
        .collect::<HashMap<_, _>>();
    for unit in units {
        unit.combat_type_name = unit
            .combat_type_id
            .as_ref()
            .and_then(|id| names.get(id))
            .cloned();
    }
    Ok(())
}

fn name_expression() -> SimpleExpr {
    Expr::cust("coalesce(sigint_unit_orbit_combat_type.name, '')")
}

pub(super) async fn apply_sort<C>(
    db: &C,
    mut units: Select<sigint_unit::Entity>,
    req: &ListUnitsReq,
    order: Order,
) -> anyhow::Result<Select<sigint_unit::Entity>>
where
    C: ConnectionTrait,
{
    let ascending = matches!(order, Order::Asc);
    let cursor_id = if ascending {
        req.after_unit_id
    } else {
        req.before_unit_id
    };
    if let Some(id) = cursor_id {
        #[derive(FromQueryResult)]
        struct Cursor {
            name: String,
        }
        let cursor = sigint_unit::Entity::find_by_id(id)
            .left_join(sigint_unit_orbit_combat_type::Entity)
            .select_only()
            .column_as(name_expression(), "name")
            .into_model::<Cursor>()
            .one(db)
            .await
            .c(h!())?
            .c(h!())?;
        let key = Expr::tuple([
            name_expression(),
            Expr::col((sigint_unit::Entity, sigint_unit::Column::Id)),
        ]);
        let cursor = SimpleExpr::Tuple(vec![cursor.name.into(), id.into()]);
        units = units.filter(if ascending {
            key.gt(cursor)
        } else {
            key.lt(cursor)
        });
    }
    Ok(units
        .order_by(name_expression(), order.clone())
        .order_by(sigint_unit::Column::Id, order))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::sigint_unit;
    use crate::functest::tests::{cleanup, mk_sigint_unit};
    use crate::sigint::unit::types::{
        ListUnitsReq, ListUnitsSortBy, UpdateUnitReq,
    };
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn regression_3113_edit_filter_sort_and_clear_combat_type() {
        let env = cleanup().await.unwrap();
        let mut ids = Vec::new();
        for name in ["Артилерія", "Піхота"] {
            let id = Uuid::new_v4();
            sigint_unit_orbit_combat_type::ActiveModel {
                id: Set(id),
                name: Set(name.to_string()),
            }
            .insert(&env.dbx)
            .await
            .unwrap();
            ids.push(id);
        }
        let unit = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                name: Set("3113 edit".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let mut req = verify_edit_persistence(&env, &unit, &ids).await;
        verify_list_filter_sort_and_pagination(&env, &unit, &ids).await;
        verify_clear_and_create(&env, &unit, &ids, &mut req).await;
    }

    async fn verify_edit_persistence(
        env: &Env,
        unit: &sigint_unit::Model,
        ids: &[Uuid],
    ) -> UpdateUnitReq {
        let mut req =
            UpdateUnitReq::from(super::super::render_unit(unit).unwrap());
        req.combat_type_id = Some(Some(ids[1].to_string()));
        let updated = super::super::update_unit_for_login(
            &env.dbx,
            &unit.created_by_login_id,
            &req,
            true,
        )
        .await
        .unwrap();
        assert_eq!(updated.combat_type_id, Some(ids[1]));
        req.combat_type_id = None;
        assert_eq!(
            super::super::update_unit_for_login(
                &env.dbx,
                &unit.created_by_login_id,
                &req,
                true
            )
            .await
            .unwrap()
            .combat_type_id,
            Some(ids[1])
        );
        req.combat_type_id = Some(Some(Uuid::new_v4().to_string()));
        assert!(super::super::update_unit_for_login(
            &env.dbx,
            &unit.created_by_login_id,
            &req,
            true
        )
        .await
        .is_err());
        req
    }

    async fn verify_list_filter_sort_and_pagination(
        env: &Env,
        unit: &sigint_unit::Model,
        ids: &[Uuid],
    ) {
        let artillery = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                combat_type_id: Set(Some(ids[0])),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let unassigned =
            mk_sigint_unit(&env.dbx, Default::default()).await.unwrap();
        let all = ListUnitsReq {
            include_inactive: true,
            filter_active: None,
            sort_by: Some(ListUnitsSortBy::UnitCombatTypeAsc),
            ..Default::default()
        };
        let page = super::super::read_units(&env.dbx, &all).await.unwrap();
        assert_eq!(
            page.units.iter().map(|unit| unit.id).collect::<Vec<_>>(),
            vec![unassigned.id, artillery.id, unit.id]
        );
        assert_eq!(
            page.units.last().unwrap().combat_type_name.as_deref(),
            Some("Піхота")
        );
        let descending = super::super::read_units(
            &env.dbx,
            &ListUnitsReq {
                sort_by: Some(ListUnitsSortBy::UnitCombatTypeDesc),
                limit: Some(1),
                offset: Some(1),
                ..all.clone()
            },
        )
        .await
        .unwrap();
        assert_eq!(descending.units[0].id, artillery.id);
        assert!(descending.show_load_more);
        verify_list_cursors(env, &all, unit.id, artillery.id, unassigned.id)
            .await;
        let filtered = super::super::read_units(
            &env.dbx,
            &ListUnitsReq {
                filter_combat_type: Some("Піхота".to_string()),
                ..all
            },
        )
        .await
        .unwrap();
        assert_eq!(filtered.total_count, 1);
        assert_eq!(filtered.units[0].id, unit.id);
    }

    async fn verify_list_cursors(
        env: &Env,
        all: &ListUnitsReq,
        unit_id: i64,
        artillery_id: i64,
        unassigned_id: i64,
    ) {
        for (sort_by, after_unit_id, before_unit_id, expected) in [
            (
                ListUnitsSortBy::UnitCombatTypeAsc,
                Some(unassigned_id),
                None,
                vec![artillery_id, unit_id],
            ),
            (
                ListUnitsSortBy::UnitCombatTypeDesc,
                None,
                Some(unit_id),
                vec![artillery_id, unassigned_id],
            ),
        ] {
            let page = super::super::read_units(
                &env.dbx,
                &ListUnitsReq {
                    sort_by: Some(sort_by),
                    after_unit_id,
                    before_unit_id,
                    ..all.clone()
                },
            )
            .await
            .unwrap();
            assert_eq!(
                page.units.iter().map(|unit| unit.id).collect::<Vec<_>>(),
                expected
            );
            assert_eq!(page.total_count, 3);
        }
    }

    async fn verify_clear_and_create(
        env: &Env,
        unit: &sigint_unit::Model,
        ids: &[Uuid],
        req: &mut UpdateUnitReq,
    ) {
        req.combat_type_id = Some(None);
        assert_eq!(
            super::super::update_unit_for_login(
                &env.dbx,
                &unit.created_by_login_id,
                req,
                true
            )
            .await
            .unwrap()
            .combat_type_id,
            None
        );
        let mut create: crate::sigint::unit::types::CreateUnitReq =
            serde_json::from_value(
                serde_json::to_value(super::super::render_unit(unit).unwrap())
                    .unwrap(),
            )
            .unwrap();
        create.combat_type_id = Some(ids[0].to_string());
        let created = super::super::insert_unit_with_changelog(
            &env.dbx,
            &unit.created_by_login_id,
            &create,
        )
        .await
        .unwrap();
        assert_eq!(created.combat_type_id, Some(ids[0]));
    }
}
