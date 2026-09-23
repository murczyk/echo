use super::types::{
    AuthorIdentitiesReq, AuthorIdentitiesRsp, AuthorIdentity,
    DisplayNameSaveReq,
};
use super::{load_active_login, login_id_from_identity};
use crate::config::{
    USER_AUTHOR_IDENTITIES_MAX_BATCH_SIZE, USER_DISPLAY_NAME_MAX_LENGTH,
};
use crate::entities::{delta_login, login};
use crate::error::AppError;
use crate::h;
use crate::types::{Env, ShortContext};
use actix_identity::Identity;
use actix_web::{
    post, put,
    web::{Data, Json},
};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, EntityTrait, JoinType,
    QueryFilter, QuerySelect, RelationTrait, Set,
};
use uuid::Uuid;

#[cfg(test)]
mod tests;

fn form_error(message: String) -> AppError {
    AppError::Form([("display_name".to_string(), message)].into())
}

fn normalize_display_name(
    value: Option<&str>,
) -> anyhow::Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    if value
        .chars()
        .any(|ch| ch.is_control() || matches!(ch, '\u{2028}' | '\u{2029}'))
    {
        return Err(form_error(
            "Ім’я має бути однорядковим і не містити керівних символів"
                .to_string(),
        ))
        .c(h!());
    }
    let value = value.trim();
    if value.chars().count() > USER_DISPLAY_NAME_MAX_LENGTH {
        return Err(form_error(format!(
            "Ім’я може містити до {USER_DISPLAY_NAME_MAX_LENGTH} символів"
        )))
        .c(h!());
    }
    Ok((!value.is_empty()).then(|| value.to_string()))
}

async fn save_display_name(
    db: &impl ConnectionTrait,
    login_id: Uuid,
    value: Option<&str>,
) -> anyhow::Result<AuthorIdentity> {
    load_active_login(db, &login_id).await.c(h!())?;
    let display_name = normalize_display_name(value).c(h!())?;
    login::Entity::update(login::ActiveModel {
        id: Set(login_id),
        display_name: Set(display_name),
        ..Default::default()
    })
    .exec(db)
    .await
    .c(h!())?;
    find_authors(
        db,
        &AuthorIdentitiesReq {
            logins: vec![],
            ids: vec![login_id.to_string()],
        },
    )
    .await
    .c(h!())?
    .into_iter()
    .next()
    .ok_or(AppError::NotFound)
    .c(h!())
}

#[put("/api/user/display-name")]
pub async fn save(
    env: Data<Env>,
    user: Identity,
    req: Json<DisplayNameSaveReq>,
) -> Result<Json<AuthorIdentity>, AppError> {
    let login_id = login_id_from_identity(&user).c(h!())?;
    Ok(Json(
        save_display_name(&env.dbx, login_id, req.display_name.as_deref())
            .await
            .c(h!())?,
    ))
}

async fn find_authors(
    db: &impl ConnectionTrait,
    req: &AuthorIdentitiesReq,
) -> anyhow::Result<Vec<AuthorIdentity>> {
    if req.logins.len() + req.ids.len() > USER_AUTHOR_IDENTITIES_MAX_BATCH_SIZE
    {
        return Err(AppError::BadRequestJson {
            body: serde_json::json!({ "error": "Забагато авторів у запиті" }),
        })
        .c(h!());
    }
    if req.logins.is_empty() && req.ids.is_empty() {
        return Ok(vec![]);
    }
    let ids = req
        .ids
        .iter()
        .map(|id| Uuid::parse_str(id))
        .collect::<Result<Vec<_>, _>>()
        .c(h!())?;
    let identities = login::Entity::find()
        .select_only()
        .columns([
            login::Column::Id,
            login::Column::Login,
            login::Column::DisplayName,
        ])
        .column_as(delta_login::Column::Login, "delta_login")
        .join(JoinType::LeftJoin, login::Relation::DeltaLogin.def())
        .filter(login::Column::DeletedPermanently.eq(false))
        .filter(
            Condition::any()
                .add(login::Column::Login.is_in(req.logins.clone()))
                .add(login::Column::Id.is_in(ids)),
        )
        .into_tuple::<(Uuid, String, Option<String>, Option<String>)>()
        .all(db)
        .await
        .c(h!())?;
    Ok(identities
        .into_iter()
        .map(|(id, login, display_name, delta_login)| AuthorIdentity {
            id: id.to_string(),
            login,
            display_name,
            delta_login,
        })
        .collect())
}

#[post("/api/user/author-identities")]
pub async fn authors(
    env: Data<Env>,
    user: Identity,
    req: Json<AuthorIdentitiesReq>,
) -> Result<Json<AuthorIdentitiesRsp>, AppError> {
    let login_id = login_id_from_identity(&user).c(h!())?;
    load_active_login(&env.dbx, &login_id).await.c(h!())?;
    Ok(Json(AuthorIdentitiesRsp {
        authors: find_authors(&env.dbx, &req).await.c(h!())?,
    }))
}
