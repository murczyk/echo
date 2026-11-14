use super::access::management_scope;
use crate::config::USER_LABEL_NAME_MAX_CHARS;
use crate::entities::{login, organism};
use crate::h;
use crate::types::{AppError, Context, Env, ShortContext};
use actix_identity::Identity;
use actix_web::{
    post,
    web::{Data, Json},
};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use serde::{Deserialize, Serialize};

#[derive(
    Debug,
    Clone,
    Serialize,
    Deserialize,
    Elm,
    ElmEncode,
    ElmDecode,
    FromQueryResult,
)]
pub struct OrganismUserLabel {
    pub id: i64,
    pub organism_id: i64,
    pub name: String,
    pub color: String,
}

#[derive(
    Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode, FromQueryResult,
)]
pub struct OrganismUserLabelAssignment {
    pub login_id: String,
    pub label_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct OrganismUserLabelsRsp {
    pub labels: Vec<OrganismUserLabel>,
    pub assignments: Vec<OrganismUserLabelAssignment>,
    pub excluded_login_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct UpsertOrganismUserLabelReq {
    pub id: Option<i64>,
    pub organism_id: i64,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct DeleteOrganismUserLabelReq {
    pub organism_id: i64,
    pub label_id: i64,
}

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct AssignOrganismUserLabelReq {
    pub organism_id: i64,
    pub login_id: String,
    pub label_id: Option<i64>,
}

#[post("/api/organism/user-labels")]
pub async fn list(
    user: Identity,
    env: Data<Env>,
    req: Json<i64>,
) -> Result<Json<OrganismUserLabelsRsp>, AppError> {
    management_scope(&env.dbx, &user)
        .await
        .context(h!())?
        .ensure_organism(req.0)
        .context(h!())?;
    let labels = OrganismUserLabel::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select id, organism_id, name, color from organism_user_label where organism_id=$1 order by lower(name), id",
        [req.0.into()],
    )).all(&env.dbx).await.c(h!())?;
    let assignments = OrganismUserLabelAssignment::find_by_statement(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select login_id::text, label_id from organism_user_label_assignment where organism_id=$1",
        [req.0.into()],
    )).all(&env.dbx).await.c(h!())?;
    let excluded_login_ids = env.dbx.query_all_raw(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "select login_id::text from organism_message_stats_exclusion where organism_id=$1 order by login_id",
        [req.0.into()],
    )).await.c(h!())?.into_iter().map(|row| row.try_get("", "login_id")).collect::<Result<Vec<String>, _>>().c(h!())?;
    Ok(Json(OrganismUserLabelsRsp {
        labels,
        assignments,
        excluded_login_ids,
    }))
}

#[post("/api/organism/user-labels/upsert")]
pub async fn upsert(
    user: Identity,
    env: Data<Env>,
    req: Json<UpsertOrganismUserLabelReq>,
) -> Result<Json<OrganismUserLabel>, AppError> {
    management_scope(&env.dbx, &user)
        .await
        .context(h!())?
        .ensure_organism(req.organism_id)
        .context(h!())?;
    let name = req.name.trim();
    if name.is_empty()
        || name.chars().count() > USER_LABEL_NAME_MAX_CHARS
        || req.color.len() != 7
        || !req.color.starts_with('#')
        || !req.color[1..].bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(AppError::BL {
            msg: "Вкажіть назву лейбла (до 80 символів) та колір #RRGGBB"
                .into(),
        });
    }
    let txn = env.dbx.begin().await.c(h!())?;
    organism::Entity::find_by_id(req.organism_id)
        .filter(organism::Column::DeletedPermanently.eq(false))
        .lock_shared()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;
    let (sql, values) = match req.id {
        Some(id) => ("update organism_user_label set name=$1, color=$2 where organism_id=$3 and id=$4 returning *", vec![name.into(), req.color.clone().into(), req.organism_id.into(), id.into()]),
        None => ("insert into organism_user_label (name,color,organism_id) values ($1,$2,$3) returning *", vec![name.into(), req.color.clone().into(), req.organism_id.into()]),
    };
    let label = OrganismUserLabel::find_by_statement(
        Statement::from_sql_and_values(DbBackend::Postgres, sql, values),
    )
    .one(&txn)
    .await
    .c(h!())?
    .ok_or(AppError::NotFound)
    .context(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(label))
}

#[post("/api/organism/user-labels/delete")]
pub async fn delete(
    user: Identity,
    env: Data<Env>,
    req: Json<DeleteOrganismUserLabelReq>,
) -> Result<Json<()>, AppError> {
    management_scope(&env.dbx, &user)
        .await
        .context(h!())?
        .ensure_organism(req.organism_id)
        .context(h!())?;
    let deleted = env
        .dbx
        .execute_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "delete from organism_user_label where organism_id=$1 and id=$2",
            [req.organism_id.into(), req.label_id.into()],
        ))
        .await
        .c(h!())?;
    if deleted.rows_affected() == 0 {
        return Err(AppError::NotFound);
    }
    Ok(Json(()))
}

#[post("/api/organism/user-labels/assign")]
pub async fn assign(
    user: Identity,
    env: Data<Env>,
    req: Json<AssignOrganismUserLabelReq>,
) -> Result<Json<()>, AppError> {
    let scope = management_scope(&env.dbx, &user).await.context(h!())?;
    scope.ensure_organism(req.organism_id).context(h!())?;
    let id = uuid::Uuid::parse_str(&req.login_id).c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let login = login::Entity::find_by_id(id)
        .filter(login::Column::DeletedPermanently.eq(false))
        .lock_exclusive()
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .context(h!())?;
    if login.organism_id != Some(req.organism_id) {
        return Err(AppError::Forbidden(
            "Користувач і лейбл мають належати одному організму".into(),
        ));
    }
    match req.label_id {
        Some(label_id) => {
            let label = OrganismUserLabel::find_by_statement(Statement::from_sql_and_values(DbBackend::Postgres,
                "select * from organism_user_label where id=$1 and organism_id=$2 for key share",
                [label_id.into(), req.organism_id.into()])).one(&txn).await.c(h!())?.ok_or(AppError::NotFound).context(h!())?;
            txn.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres,
                "insert into organism_user_label_assignment (login_id,organism_id,label_id) values ($1,$2,$3) on conflict (login_id) do update set organism_id=excluded.organism_id, label_id=excluded.label_id",
                [id.into(), req.organism_id.into(), label.id.into()])).await.c(h!())?;
        }
        None => {
            txn.execute_raw(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "delete from organism_user_label_assignment where login_id=$1",
                [id.into()],
            ))
            .await
            .c(h!())?;
        }
    }
    txn.commit().await.c(h!())?;
    Ok(Json(()))
}

pub async fn revision<C: ConnectionTrait>(db: &C) -> anyhow::Result<i64> {
    let row = db
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "select revision from organism_user_label_revision".to_owned(),
        ))
        .await
        .c(h!())?
        .c(h!())?;
    row.try_get("", "revision").c(h!())
}

pub fn sender_mapping_sql() -> &'static str {
    r#"select sender, case when count(*) filter (where direct) > 0 then max(label_id) filter (where direct)
        when count(distinct identities.login_id) = 1 then max(label_id) end as label_id,
        case when count(*) filter (where direct) > 0 then max(identities.organism_id) filter (where direct)
        when count(distinct identities.login_id) = 1 then max(identities.organism_id) end as organism_id
    from (
        select l.id::text as sender, l.id as login_id, a.label_id, l.organism_id, true as direct
        from login l left join organism_user_label_assignment a on a.login_id=l.id
        where not l.deleted_permanently
        union all
        select l.signal_profile_id, l.id, a.label_id, l.organism_id, false
        from login l left join organism_user_label_assignment a on a.login_id=l.id
        where not l.deleted_permanently and l.signal_profile_id is not null
        union all
        select s.sender_uuid::text, l.id, a.label_id, l.organism_id, false
        from api_sender s join login l on l.id=s.login_id
        left join organism_user_label_assignment a on a.login_id=l.id
        where not l.deleted_permanently
    ) identities left join organism_message_stats_exclusion exclusion on exclusion.login_id=identities.login_id
    group by sender
    having not case when count(*) filter (where direct) > 0
        then bool_or(exclusion.login_id is not null) filter (where direct)
        when count(distinct identities.login_id) = 1 then bool_or(exclusion.login_id is not null)
        else false end"#
}
