use crate::config::COMPUTER_NAME_SEARCH_LIMIT;
use crate::entities::computer_name;
use crate::error::AppError;
use crate::types::*;
use sea_orm::sea_query::Expr;
use sea_orm::*;

pub struct ComputerNameRow {
    pub id: i64,
    pub name: Option<String>,
}

pub async fn find_by_exact_name<C>(
    dbx: &C,
    name: &str,
) -> Result<Option<ComputerNameRow>, AppError>
where
    C: ConnectionTrait,
{
    Ok(select_computer_name()
        .filter(Expr::cust_with_values(
            "lower(coalesce(\"computer_name\".\"name\", '')) = lower($1)",
            vec![name.to_string()],
        ))
        .into_tuple::<(i64, Option<String>)>()
        .one(dbx)
        .await
        .c(h!())?
        .map(render_computer_name_row))
}

pub async fn create<C>(
    dbx: &C,
    login: String,
    name: String,
) -> Result<ComputerNameRow, AppError>
where
    C: ConnectionTrait,
{
    let computer_name = computer_name::ActiveModel {
        id: NotSet,
        name: Set(Some(name.clone())),
        login: Set(login),
        created_at: NotSet,
        search_tsv: NotSet,
    };
    let computer_name = computer_name::Entity::insert(computer_name)
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(ComputerNameRow {
        id: computer_name.last_insert_id,
        name: Some(name),
    })
}

fn select_computer_name() -> Select<computer_name::Entity> {
    computer_name::Entity::find()
        .select_only()
        .column(computer_name::Column::Id)
        .column(computer_name::Column::Name)
}

fn render_computer_name_row(
    (id, name): (i64, Option<String>),
) -> ComputerNameRow {
    ComputerNameRow { id, name }
}

pub async fn search<C>(
    dbx: &C,
    search_phrase: &str,
) -> Result<Vec<ComputerNameRow>, AppError>
where
    C: ConnectionTrait,
{
    Ok(select_computer_name()
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
        .into_tuple::<(i64, Option<String>)>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(render_computer_name_row)
        .collect())
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
