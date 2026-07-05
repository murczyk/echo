use crate::config::COMPUTER_NAME_SEARCH_LIMIT;
use crate::entities::computer_name;
use crate::error::AppError;
use crate::types::*;
use sea_orm::sea_query::Expr;
use sea_orm::*;

pub async fn find_by_exact_name<C>(
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

pub async fn create<C>(
    dbx: &C,
    login: String,
    name: String,
) -> Result<computer_name::Model, AppError>
where
    C: ConnectionTrait,
{
    Ok(computer_name::ActiveModel {
        id: NotSet,
        name: Set(Some(name)),
        login: Set(login),
        created_at: NotSet,
        search_tsv: NotSet,
    }
    .insert(dbx)
    .await
    .c(h!())?)
}

pub async fn search<C>(
    dbx: &C,
    search_phrase: &str,
) -> Result<Vec<computer_name::Model>, AppError>
where
    C: ConnectionTrait,
{
    Ok(computer_name::Entity::find()
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
        .all(dbx)
        .await
        .c(h!())?)
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
