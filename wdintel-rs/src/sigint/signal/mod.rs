use self::types::*;
use crate::entities::*;
use crate::error::AppError;
use crate::event_stream::fanout;
use crate::event_stream::types::*;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use itertools::Itertools;
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    const LIMIT: u64 = 100000;

    let signals = list_signals_impl(&env.dbx, &req.0, Some(LIMIT))
        .await
        .c(h!())?;

    Ok(Json(ListSignalsRsp {
        show_load_more: signals.len() as u64 == LIMIT,
        signals,
    }))
}

#[post("/api/sigint/signals/csv")]
pub async fn list_signals_csv(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ListSignalsReq>,
    http_req: actix_web::HttpRequest,
) -> Result<actix_web::HttpResponse, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;

    let signals = list_signals_impl(&env.dbx, &req.0, None).await.c(h!())?;
    let sigint_unit_ids: Vec<i64> = signals
        .iter()
        .flat_map(|signal| signal.unit.clone())
        .unique()
        .collect();

    let units: HashMap<i64, String> = sigint_unit::Entity::find()
        .filter(sigint_unit::Column::Id.is_in(sigint_unit_ids))
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .map(|unit| (unit.id, unit.name))
        .collect();

    let temp_file = tempfile::Builder::new()
        .prefix("sigint-signals")
        .suffix(".csv")
        .rand_bytes(5)
        .tempfile()
        .context(h!())?;

    let temp_file_name = temp_file.path().to_str().context(h!())?;
    {
        #[derive(Serialize, Debug)]
        struct SignalCsvRow<'a> {
            pub id: i64,
            pub text: String,
            pub meaning: Option<String>,
            pub unit_id: Option<i64>,
            pub unit_name: Option<&'a str>,
            pub active: bool,
            pub coordinates: Option<String>,
            pub created_at: String,
        }

        let tz = crate::config::get_tz();
        let mut wtr = csv::Writer::from_path(temp_file_name).c(h!())?;
        for signal in signals.into_iter() {
            let created_at =
                chrono::DateTime::from_timestamp_millis(signal.created_at)
                    .unwrap();
            let row = SignalCsvRow {
                id: signal.id,
                text: signal.text,
                meaning: signal.meaning,
                unit_id: signal.unit,
                unit_name: signal
                    .unit
                    .and_then(|id| units.get(&id).map(String::as_str)),
                active: signal.active,
                coordinates: signal.coordinates,
                created_at: created_at
                    .with_timezone(&tz)
                    .format("%Y-%m-%d %H:%M:%S")
                    .to_string(),
            };
            wtr.serialize(&row).c(h!())?;
        }
        wtr.flush().c(h!())?;
    }

    let file = actix_files::NamedFile::open_async(temp_file_name)
        .await
        .c(h!())?;
    Ok(file.into_response(&http_req))
}

async fn list_signals_impl(
    dbx: &DatabaseConnection,
    req: &ListSignalsReq,
    limit: Option<u64>,
) -> Result<Vec<Signal>, AppError> {
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
        .limit(limit)
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(move |(signal, unit)| render_signal(signal, unit))
        .collect();

    Ok(signals)
}

pub async fn find_signal(
    dbx: &DbConn,
    id: i64,
) -> Result<sigint_signal::Model, AppError> {
    sigint_signal::Entity::find_by_id(id)
        .filter(sigint_signal::Column::Deleted.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
}

#[post("/api/sigint/signal/unit-stats")]
pub async fn signal_unit_stats(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    _req: Json<()>,
) -> Result<Json<SignalUnitStatsRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
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
        .await
        .c(h!())?;
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .c(h!())?;

    let res = sigint_signal::ActiveModel {
        id: NotSet,
        text: Set(req.text.clone()),
        meaning: Set(req.meaning.clone()),
        unit: if let Some(unit_id) = req.unit {
            Set(Some(
                crate::sigint::unit::find_unit(&env.dbx, unit_id)
                    .await
                    .c(h!())?
                    .id,
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
        login: Set(user.id().c(h!())?),
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .c(h!())?;

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
        login: Set(user.id().c(h!())?),
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
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Rer")
        .await
        .c(h!())?;
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "UnitsEditor")
        .await
        .c(h!())?;

    let mut signal: sigint_signal::ActiveModel =
        find_signal(&env.dbx, req.0).await.context(h!())?.into();

    signal.deleted = Set(true);

    let res_id = signal.update(&env.dbx).await.context(h!())?.id;

    sigint_signal_changelog::ActiveModel {
        id: NotSet,
        sigint_signal_id: Set(res_id),
        login: Set(user.id().c(h!())?),
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
    signal: sigint_signal::Model,
    unit: Option<sigint_unit::Model>,
) -> Signal {
    Signal {
        id: signal.id,
        text: signal.text,
        meaning: signal.meaning,
        unit: signal.unit,
        active: unit.is_none_or(|u| u.active),
        coordinates: signal.coordinates,
        created_at: signal.created_at.and_utc().timestamp_millis(),
    }
}
