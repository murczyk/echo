use self::types::{
    ComputerNameSearchReq, ComputerNameSearchResult, ComputerNameSearchRsp,
};
use crate::config::COMPUTER_NAME_SEARCH_LIMIT;
use crate::entities::computer_name;
use crate::error::AppError;
use crate::types::*;
use actix_web::post;
use actix_web::web::Json;
use sea_orm::sea_query::Expr;
use sea_orm::*;

pub mod types;

#[post("/api/sigint/computer-name/search")]
pub async fn computer_name_search(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ComputerNameSearchReq>,
) -> Result<Json<ComputerNameSearchRsp>, AppError> {
    crate::users::has_any_role(&env.dbx, &user.id().c(h!())?, vec!["Rer"])
        .await
        .c(h!())?;

    let search_phrase = req.search.trim();
    if search_phrase.is_empty() {
        return Ok(Json(ComputerNameSearchRsp { computers: vec![] }));
    }

    let computers = computer_name::Entity::find()
        .filter(computer_name::Column::Name.is_not_null())
        .filter(Expr::cust_with_values(
            "search_tsv @@ websearch_to_tsquery('simple', $1) OR lower(\"computer_name\".\"name\") LIKE lower($2) ESCAPE '\\'",
            vec![
                search_phrase.to_string(),
                format!("%{}%", escape_like(search_phrase)),
            ],
        ))
        .order_by_asc(computer_name::Column::Name)
        .limit(COMPUTER_NAME_SEARCH_LIMIT)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|computer| {
            computer.name.map(|name| ComputerNameSearchResult {
                id: computer.id,
                name,
            })
        })
        .collect();

    Ok(Json(ComputerNameSearchRsp { computers }))
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
