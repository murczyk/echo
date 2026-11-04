pub mod access;
pub mod accounts;
pub mod types;

use crate::error::AppError;
use crate::h;
use crate::messengers::access::ensure_messengers_access;
use crate::messengers::types::{
    MessengersAccountsListReq, MessengersAccountsListRsp,
};
use crate::types::{Env, ShortContext};
use actix_web::post;
use actix_web::web::{Data, Json};

// Routes of the read-only messengers viewer API, `/api/messengers`. Handlers
// only gate access and delegate to the per-entity modules.

#[post("/api/messengers/accounts/list")]
pub async fn accounts_list(
    user: actix_identity::Identity,
    env: Data<Env>,
    _req: Json<MessengersAccountsListReq>,
) -> Result<Json<MessengersAccountsListRsp>, AppError> {
    let scope = ensure_messengers_access(&env.dbx, &user).await.c(h!())?;
    let rsp = accounts::list_accounts(&env.dbx, &scope).await.c(h!())?;
    Ok(Json(rsp))
}
