pub mod bl;
pub mod types;

use self::bl::{
    keyword_set_can_delete, keyword_set_can_edit, keyword_set_can_manage,
    keyword_set_name_taken_err, map_keyword_set_db_err, merge_lexeme_batches,
    normalize_keyword_words,
};
use self::types::*;
use crate::config::{
    ORGANISM_KEYWORD_SET_DEFAULT_NAME, ORGANISM_KEYWORD_SET_INFLECT_MAX_LEMMAS,
    ORGANISM_KEYWORD_SET_MAX_SETS_PER_ORGANISM,
};
use crate::entities::{login, organism_keyword_set};
use crate::error::AppError;
use crate::rer_importer::keywords::get_keywords;
use crate::types::*;
use actix_web::web::{Data, Path};
use actix_web::{delete, get, post, put, web::Json};
use chrono::Utc;
use sea_orm::sea_query::OnConflict;
use sea_orm::*;
pub async fn try_resolve_viewer_organism_id(
    dbx: &DatabaseConnection,
    login: &str,
) -> Result<Option<i64>, AppError> {
    let login_obj = login::Entity::find()
        .filter(login::Column::Login.eq(login.to_string()))
        .filter(login::Column::DeletedPermanently.eq(false))
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())?;
    Ok(login_obj.organism_id)
}

pub async fn resolve_viewer_organism_id(
    dbx: &DatabaseConnection,
    login: &str,
) -> Result<i64, AppError> {
    try_resolve_viewer_organism_id(dbx, login)
        .await?
        .ok_or_else(|| AppError::BL {
            msg: "User without organism_id is not supported".to_string(),
        })
}

fn words_from_json(jv: &sea_orm::entity::prelude::Json) -> Result<Vec<String>, AppError> {
    serde_json::from_value(jv.clone()).map_err(|e| AppError::BL {
        msg: format!("Invalid keyword words json: {e}"),
    })
}

fn viewer_is_admin(dbx: &DatabaseConnection, login: &str) -> bool {
    crate::users::has_role(dbx, login, "Admin").await.is_ok()
}

fn dto_from_model(
    row: organism_keyword_set::Model,
    login: &str,
    is_admin: bool,
) -> OrganismKeywordSetDto {
    let words = words_from_json(&row.words).unwrap_or_default();
    let can_edit = keyword_set_can_edit(
        row.is_system_default,
        row.author_login.as_deref(),
        login,
        is_admin,
    );
    let can_delete = keyword_set_can_delete(
        row.is_system_default,
        row.author_login.as_deref(),
        login,
        is_admin,
    );
    OrganismKeywordSetDto {
        id: row.id,
        name: row.name,
        words,
        author_login: row.author_login,
        is_system_default: row.is_system_default,
        can_edit,
        can_delete,
    }
}

pub async fn ensure_default_keyword_set(
    dbx: &DatabaseConnection,
    organism_id: i64,
) -> Result<organism_keyword_set::Model, AppError> {
    if let Some(existing) = organism_keyword_set::Entity::find()
        .filter(organism_keyword_set::Column::OrganismId.eq(organism_id))
        .filter(organism_keyword_set::Column::IsSystemDefault.eq(true))
        .one(dbx)
        .await
        .c(h!())?
    {
        return Ok(existing);
    }

    let words: Vec<String> = get_keywords().into_iter().collect();
    let words_json = serde_json::to_value(&words).c(h!())?;
    organism_keyword_set::Entity::insert(organism_keyword_set::ActiveModel {
        id: NotSet,
        organism_id: Set(organism_id),
        author_login: Set(None),
        name: Set(ORGANISM_KEYWORD_SET_DEFAULT_NAME.to_string()),
        words: Set(words_json),
        is_system_default: Set(true),
        updated_at: Set(Utc::now().naive_utc()),
    })
    .on_conflict(
        OnConflict::columns([
            organism_keyword_set::Column::OrganismId,
            organism_keyword_set::Column::Name,
        ])
        .do_nothing()
        .to_owned(),
    )
    .exec(dbx)
    .await
    .c(h!())?;

    organism_keyword_set::Entity::find()
        .filter(organism_keyword_set::Column::OrganismId.eq(organism_id))
        .filter(organism_keyword_set::Column::IsSystemDefault.eq(true))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: format!("Default keyword set missing for organism_id={organism_id}"),
        })
}

pub async fn resolve_inbox_keyword_words(
    dbx: &DatabaseConnection,
    organism_id: i64,
    set_id: Option<i64>,
    enabled: bool,
) -> Result<Vec<String>, AppError> {
    if !enabled {
        return Ok(vec![]);
    }
    ensure_default_keyword_set(dbx, organism_id).await.c(h!())?;
    let row = match set_id {
        Some(id) => organism_keyword_set::Entity::find_by_id(id)
            .filter(organism_keyword_set::Column::OrganismId.eq(organism_id))
            .one(dbx)
            .await
            .c(h!())?,
        None => None,
    };
    let row = match row {
        Some(r) => r,
        None => organism_keyword_set::Entity::find()
            .filter(organism_keyword_set::Column::OrganismId.eq(organism_id))
            .filter(organism_keyword_set::Column::IsSystemDefault.eq(true))
            .one(dbx)
            .await
            .c(h!())?
            .c(h!())?,
    };
    normalize_keyword_words(&words_from_json(&row.words)?)
}

async fn ensure_keyword_set_name_available(
    dbx: &DatabaseConnection,
    organism_id: i64,
    name: &str,
    exclude_id: Option<i64>,
) -> Result<(), AppError> {
    let mut query = organism_keyword_set::Entity::find()
        .filter(organism_keyword_set::Column::OrganismId.eq(organism_id))
        .filter(organism_keyword_set::Column::Name.eq(name));
    if let Some(id) = exclude_id {
        query = query.filter(organism_keyword_set::Column::Id.ne(id));
    }
    if query.one(dbx).await.c(h!())?.is_some() {
        return Err(keyword_set_name_taken_err());
    }
    Ok(())
}

async fn load_set_for_viewer(
    dbx: &DatabaseConnection,
    organism_id: i64,
    set_id: i64,
) -> Result<organism_keyword_set::Model, AppError> {
    organism_keyword_set::Entity::find_by_id(set_id)
        .filter(organism_keyword_set::Column::OrganismId.eq(organism_id))
        .one(dbx)
        .await
        .c(h!())?
        .ok_or_else(|| AppError::BL {
            msg: "Набір ключових слів не знайдено".to_string(),
        })
}

#[get("/api/organism/keyword-sets")]
pub async fn list_keyword_sets(
    user: actix_identity::Identity,
    env: Data<Env>,
) -> Result<Json<Vec<OrganismKeywordSetDto>>, AppError> {
    let login = user.id().c(h!())?;
    let is_admin = viewer_is_admin(&env.dbx, &login).await;
    let organism_id = resolve_viewer_organism_id(&env.dbx, &login).await?;
    ensure_default_keyword_set(&env.dbx, organism_id)
        .await
        .c(h!())?;
    let rows = organism_keyword_set::Entity::find()
        .filter(organism_keyword_set::Column::OrganismId.eq(organism_id))
        .order_by_asc(organism_keyword_set::Column::IsSystemDefault)
        .order_by_asc(organism_keyword_set::Column::Name)
        .all(&env.dbx)
        .await
        .c(h!())?;
    Ok(Json(
        rows.into_iter()
            .map(|r| dto_from_model(r, &login, is_admin))
            .collect(),
    ))
}

#[put("/api/organism/keyword-sets")]
pub async fn upsert_keyword_set(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<OrganismKeywordSetUpsertReq>,
) -> Result<Json<OrganismKeywordSetDto>, AppError> {
    let login = user.id().c(h!())?;
    let is_admin = viewer_is_admin(&env.dbx, &login).await;
    let organism_id = resolve_viewer_organism_id(&env.dbx, &login).await?;
    let words = normalize_keyword_words(&req.words)?;
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::BL {
            msg: "Назва набору не може бути порожньою".to_string(),
        });
    }

    let now = Utc::now().naive_utc();
    let words_json = serde_json::to_value(&words).c(h!())?;

    let row = match req.id {
        Some(id) => {
            let existing =
                load_set_for_viewer(&env.dbx, organism_id, id).await?;
            if existing.is_system_default {
                if name != ORGANISM_KEYWORD_SET_DEFAULT_NAME {
                    return Err(AppError::BL {
                        msg: "Системний набір не можна перейменувати"
                            .to_string(),
                    });
                }
            } else if !keyword_set_can_manage(
                existing.author_login.as_deref(),
                &login,
                is_admin,
            ) {
                return Err(AppError::BL {
                    msg: "Немає прав на редагування цього набору".to_string(),
                });
            } else if name != existing.name {
                ensure_keyword_set_name_available(
                    &env.dbx,
                    organism_id,
                    name,
                    Some(id),
                )
                .await?;
            }
            let is_default = existing.is_system_default;
            let mut active: organism_keyword_set::ActiveModel = existing.into();
            if !is_default {
                active.name = Set(name.to_string());
            }
            active.words = Set(words_json);
            active.updated_at = Set(now);
            active
                .update(&env.dbx)
                .await
                .map_err(map_keyword_set_db_err)?
        }
        None => {
            if name == ORGANISM_KEYWORD_SET_DEFAULT_NAME {
                return Err(AppError::BL {
                    msg: "Ця назва зарезервована для системного набору"
                        .to_string(),
                });
            }
            let set_count = organism_keyword_set::Entity::find()
                .filter(
                    organism_keyword_set::Column::OrganismId.eq(organism_id),
                )
                .count(&env.dbx)
                .await
                .c(h!())? as usize;
            if set_count >= ORGANISM_KEYWORD_SET_MAX_SETS_PER_ORGANISM {
                return Err(AppError::BL {
                    msg: format!(
                        "Досягнуто ліміт {} наборів на організм",
                        ORGANISM_KEYWORD_SET_MAX_SETS_PER_ORGANISM
                    ),
                });
            }
            ensure_keyword_set_name_available(&env.dbx, organism_id, name, None)
                .await?;
            organism_keyword_set::ActiveModel {
                id: NotSet,
                organism_id: Set(organism_id),
                author_login: Set(Some(login.clone())),
                name: Set(name.to_string()),
                words: Set(words_json),
                is_system_default: Set(false),
                updated_at: Set(now),
            }
            .insert(&env.dbx)
            .await
            .map_err(map_keyword_set_db_err)?
        }
    };

    Ok(Json(dto_from_model(row, &login, is_admin)))
}

#[delete("/api/organism/keyword-sets/{id}")]
pub async fn delete_keyword_set(
    user: actix_identity::Identity,
    env: Data<Env>,
    path: Path<i64>,
) -> Result<Json<()>, AppError> {
    let login = user.id().c(h!())?;
    let is_admin = viewer_is_admin(&env.dbx, &login).await;
    let organism_id = resolve_viewer_organism_id(&env.dbx, &login).await?;
    let id = path.into_inner();
    let existing = load_set_for_viewer(&env.dbx, organism_id, id).await?;
    if !keyword_set_can_delete(
        existing.is_system_default,
        existing.author_login.as_deref(),
        &login,
        is_admin,
    ) {
        return Err(AppError::BL {
            msg: if existing.is_system_default {
                "Системний набір не можна видалити".to_string()
            } else {
                "Немає прав на видалення цього набору".to_string()
            },
        });
    }
    organism_keyword_set::Entity::delete_by_id(id)
        .exec(&env.dbx)
        .await
        .c(h!())?;
    Ok(Json(()))
}

#[post("/api/organism/keyword-sets/inflect")]
pub async fn inflect_keyword_set(
    user: actix_identity::Identity,
    env: Data<Env>,
    req: Json<OrganismKeywordSetInflectReq>,
) -> Result<Json<OrganismKeywordSetInflectRsp>, AppError> {
    let _login = user.id().c(h!())?;
    let _organism_id = resolve_viewer_organism_id(&env.dbx, &_login).await?;
    let lemmas: Vec<String> = req
        .lemmas
        .iter()
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty())
        .collect();
    if lemmas.is_empty() {
        return Ok(Json(OrganismKeywordSetInflectRsp { words: vec![] }));
    }
    if lemmas.len() > ORGANISM_KEYWORD_SET_INFLECT_MAX_LEMMAS {
        return Err(AppError::BL {
            msg: format!(
                "За один запит можна згенерувати форми щонайбільше для {} слів",
                ORGANISM_KEYWORD_SET_INFLECT_MAX_LEMMAS
            ),
        });
    }
    let lexemes_batch = crate::nlp::token_lexemes_batch(&env.rq, lemmas)
        .await
        .c(h!())?;
    let words = merge_lexeme_batches(lexemes_batch);
    Ok(Json(OrganismKeywordSetInflectRsp { words }))
}
