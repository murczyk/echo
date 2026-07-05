use self::types::{
    ComputerNameSearchReq, ComputerNameSearchResult, ComputerNameSearchRsp,
    CreateComputerNameReq, CreateComputerNameRsp,
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

#[post("/api/sigint/computer-name/create")]
pub async fn computer_name_create(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateComputerNameReq>,
) -> Result<Json<CreateComputerNameRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_any_role(&env.dbx, &login, vec!["Rer"])
        .await
        .c(h!())?;

    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BL {
            msg: "computer name cannot be empty".to_string(),
        });
    }

    if let Some(computer) = find_computer_name_by_exact_name(&env.dbx, &name)
        .await
        .c(h!())?
    {
        return Ok(Json(CreateComputerNameRsp {
            computer: render_computer_name(computer).c(h!())?,
        }));
    }

    let computer = computer_name::ActiveModel {
        id: NotSet,
        name: Set(Some(name)),
        login: Set(login),
        created_at: NotSet,
        search_tsv: NotSet,
    }
    .insert(&env.dbx)
    .await
    .c(h!())?;

    Ok(Json(CreateComputerNameRsp {
        computer: render_computer_name(computer).c(h!())?,
    }))
}

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

async fn find_computer_name_by_exact_name<C>(
    dbx: &C,
    name: &str,
) -> Result<Option<computer_name::Model>, AppError>
where
    C: ConnectionTrait,
{
    Ok(computer_name::Entity::find()
        .filter(Expr::cust_with_values(
            "lower(coalesce(\"computer_name\".\"name\", '')) = lower($1)",
            vec![name.to_string()],
        ))
        .one(dbx)
        .await
        .c(h!())?)
}

fn render_computer_name(
    computer: computer_name::Model,
) -> Result<ComputerNameSearchResult, AppError> {
    Ok(ComputerNameSearchResult {
        id: computer.id,
        name: computer.name.ok_or_else(|| AppError::BL {
            msg: format!("computer name #{} has empty name", computer.id),
        })?,
    })
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
