use crate::config::USER_MESSENGER_PROFILE_SEARCH_LIMIT;
use crate::rer_importer::types::{SignalProfileEntry, SignalProfilesRsp};
use crate::types::{AppError, Env, ShortContext};
use crate::{h, users};
use actix_identity::Identity;
use actix_web::post;
use actix_web::web::{Data, Json};
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Elm, ElmEncode, ElmDecode)]
pub struct MessengerProfileSearchReq {
    pub query: String,
}

#[post("/api/users/messenger-profiles")]
pub async fn search(
    env: Data<Env>,
    user: Identity,
    req: Json<MessengerProfileSearchReq>,
) -> Result<Json<SignalProfilesRsp>, AppError> {
    users::ensure_admin(&env.dbx, &user).await.c(h!())?;
    #[derive(FromQueryResult)]
    struct Profile {
        uuid: String,
        given_name: Option<String>,
        family_name: Option<String>,
    }
    let query = req.query.trim().to_lowercase();
    let prefix = format!(
        "{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let profiles = Profile::find_by_statement(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        format!("select uuid, given_name, family_name from signal_profile where uuid like $1 or lower(coalesce(given_name, '') || ' ' || coalesce(family_name, '')) like $1 order by uuid limit {USER_MESSENGER_PROFILE_SEARCH_LIMIT}"),
        vec![prefix.into()],
    )).all(&env.dbx).await.c(h!())?;
    Ok(Json(SignalProfilesRsp {
        data: profiles
            .into_iter()
            .map(|profile| {
                (
                    profile.uuid,
                    Some(SignalProfileEntry {
                        given_name: profile.given_name,
                        family_name: profile.family_name,
                    }),
                )
            })
            .collect(),
    }))
}
