use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::{
    sea_query::{extension::postgres::PgExpr, Expr},
    *,
};
use sea_query::Alias;

pub mod types;

#[post("/api/sigint/signals")]
pub async fn list_signals(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListSignalsReq>,
) -> Result<Json<ListSignalsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    const LIMIT: u64 = 100000;
    let q = sigint_signal::Entity::find()
        .find_also_related(sigint_unit::Entity)
        .filter(sigint_signal::Column::Deleted.eq(false))
        .apply_if(req.filter_text.as_ref(), |q, text| {
            q.filter(
                Expr::col(sigint_signal::Column::Text)
                    .ilike(format!("%{text}%")),
            )
        })
        .apply_if(req.filter_meaning.as_ref(), |q, meaning| {
            q.filter(
                Expr::col(sigint_signal::Column::Meaning)
                    .ilike(format!("%{meaning}%")),
            )
        })
        .apply_if(req.filter_unit.as_ref(), |q, unit| {
            q.filter(
                Expr::col(sigint_unit::Column::Name).ilike(format!("%{unit}%")),
            )
        });
    let q = req.sort_by.iter().fold(q, |q, sort_by| match sort_by {
        ListSignalsSortBy::SignalsCreatedAtAsc => {
            q.order_by_asc(sigint_signal::Column::CreatedAt)
        }
        ListSignalsSortBy::SignalsCreatedAtDesc => {
            q.order_by_desc(sigint_signal::Column::CreatedAt)
        }
    });
    let signals: Vec<types::Signal> = q
        .limit(LIMIT)
        .all(&env.dbx)
        .await?
        .into_iter()
        .map(move |(signal, unit)| render_signal(&signal, unit))
        .collect();

    Ok(Json(ListSignalsRsp {
        show_load_more: signals.len() as u64 == LIMIT,
        signals,
    }))
}

pub async fn find_signal(
    dbx: &DbConn,
    id: i64,
) -> Result<sigint_signal::Model, AppError> {
    sigint_signal::Entity::find_by_id(id)
        .filter(sigint_signal::Column::Deleted.eq(false))
        .one(dbx)
        .await?
        .ok_or(AppError::NotFound)
}

#[post("/api/sigint/signal/unit-stats")]
pub async fn signal_unit_stats(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    _req: Json<()>,
) -> Result<Json<SignalUnitStatsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    #[derive(FromQueryResult)]
    struct Row {
        unit_id: i64,
        count: i64,
    }
    let units = sigint_signal::Entity::find()
        .filter(sigint_signal::Column::Deleted.eq(false))
        .filter(sigint_signal::Column::Unit.is_not_null())
        .join_as(
            JoinType::LeftJoin,
            sigint_signal::Relation::SigintUnit.def(),
            Alias::new("sigint_unit"),
        )
        .select_only()
        .column_as(sigint_signal::Column::Unit.count(), "count")
        .column_as(sigint_signal::Column::Unit, "unit_id")
        .order_by_asc(sigint_unit::Column::Army)
        .order_by_asc(sigint_unit::Column::Division)
        .order_by_asc(sigint_unit::Column::Regiment)
        .order_by_asc(sigint_unit::Column::Battalion)
        .order_by_asc(sigint_unit::Column::Company)
        .group_by(sigint_signal::Column::Unit)
        .group_by(sigint_unit::Column::Army)
        .group_by(sigint_unit::Column::Division)
        .group_by(sigint_unit::Column::Regiment)
        .group_by(sigint_unit::Column::Battalion)
        .group_by(sigint_unit::Column::Company)
        .into_model::<Row>()
        .all(&env.dbx)
        .await?;
    let mut res = vec![];
    for unit in units {
        res.push(SignalUnitStatRow {
            unit_id: unit.unit_id,
            count: unit.count,
        });
    }
    Ok(Json(SignalUnitStatsRsp { units: res }))
}

#[post("/api/sigint/signal/create")]
pub async fn create_signal(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateSignalReq>,
) -> Result<Json<i64>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor").await?;

    let res = sigint_signal::ActiveModel {
        id: NotSet,
        text: Set(req.text.clone()),
        meaning: Set(req.meaning.clone()),
        unit: if let Some(unit_id) = req.unit {
            Set(Some(
                crate::sigint::unit::find_unit(&env.dbx, unit_id).await?.id,
            ))
        } else {
            NotSet
        },
        deleted: Set(false),
        coordinates: Set(req.coordinates.clone()),
        created_at: NotSet,
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    sigint_signal_changelog::ActiveModel {
        id: NotSet,
        sigint_signal_id: Set(res.id),
        login: Set(user.id()?),
        action: Set(
            sea_orm_active_enums::SigintSignalChangelogActionEnum::Create,
        ),
        created_at: NotSet,
        new_value: Set(None),
        old_value: Set(None),
        req: Set(Some(serde_json::to_value(&req).context(h!())?)),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    let event = EventMsg::new(EventType::ETSignalChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(Json(res.id))
}

#[post("/api/sigint/signal/update")]
pub async fn update_signal(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<UpdateSignalReq>,
) -> Result<Json<i64>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor").await?;

    let mut signal: sigint_signal::ActiveModel =
        find_signal(&env.dbx, req.id).await.context(h!())?.into();

    signal.text = Set(req.text.clone());
    signal.meaning = Set(req.meaning.clone());
    signal.coordinates = Set(req.coordinates.clone());
    signal.unit = if let Some(unit_id) = req.unit {
        Set(Some(
            crate::sigint::unit::find_unit(&env.dbx, unit_id)
                .await
                .context(h!())?
                .id,
        ))
    } else {
        NotSet
    };

    let res = signal.update(&env.dbx).await.context(h!())?;

    sigint_signal_changelog::ActiveModel {
        id: NotSet,
        sigint_signal_id: Set(res.id),
        login: Set(user.id()?),
        action: Set(
            sea_orm_active_enums::SigintSignalChangelogActionEnum::Update,
        ),
        created_at: NotSet,
        new_value: Set(None),
        old_value: Set(None),
        req: Set(Some(serde_json::to_value(&req).context(h!())?)),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    let event = EventMsg::new(EventType::ETSignalChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(Json(res.id))
}

#[post("/api/sigint/signal/delete")]
pub async fn delete_signal(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<i64>,
) -> Result<Json<i64>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer").await?;
    crate::users::has_role(&env.dbx, &user.id()?, "UnitsEditor").await?;

    let mut signal: sigint_signal::ActiveModel =
        find_signal(&env.dbx, req.0).await.context(h!())?.into();

    signal.deleted = Set(true);

    let res_id = signal.update(&env.dbx).await.context(h!())?.id;

    sigint_signal_changelog::ActiveModel {
        id: NotSet,
        sigint_signal_id: Set(res_id),
        login: Set(user.id()?),
        action: Set(
            sea_orm_active_enums::SigintSignalChangelogActionEnum::Delete,
        ),
        created_at: NotSet,
        new_value: Set(None),
        old_value: Set(None),
        req: Set(Some(serde_json::to_value(&req).context(h!())?)),
        sigint_origin_id: NotSet,
        original_id: NotSet,
    }
    .insert(&env.dbx)
    .await
    .context(h!())?;

    let event = EventMsg::new(EventType::ETSignalChanged);
    fanout(&mut env.redis.clone(), event).await.context(h!())?;

    Ok(Json(res_id))
}

pub fn render_signal(
    signal: &sigint_signal::Model,
    unit: Option<sigint_unit::Model>,
) -> Signal {
    Signal {
        id: signal.id,
        text: signal.text.clone(),
        meaning: signal.meaning.clone(),
        unit: signal.unit,
        active: unit.is_none_or(|u| u.active),
        coordinates: signal.coordinates.clone(),
        created_at: signal.created_at.and_utc().timestamp_millis(),
    }
}
