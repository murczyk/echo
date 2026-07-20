use crate::config::DEVICE_NAME_SEARCH_LIMIT;
use crate::entities::device_name;
use crate::error::AppError;
use crate::types::*;
use sea_orm::sea_query::Expr;
use sea_orm::*;

pub struct DeviceNameRow {
    pub id: i64,
    pub name: Option<String>,
}

pub async fn find_by_exact_name<C>(
    dbx: &C,
    name: &str,
) -> Result<Option<DeviceNameRow>, AppError>
where
    C: ConnectionTrait,
{
    Ok(select_device_name()
        .filter(Expr::cust_with_values(
            "lower(coalesce(\"device_name\".\"name\", '')) = lower($1)",
            vec![name.to_string()],
        ))
        .into_tuple::<(i64, Option<String>)>()
        .one(dbx)
        .await
        .c(h!())?
        .map(render_device_name_row))
}

pub async fn create<C>(
    dbx: &C,
    login: uuid::Uuid,
    name: String,
) -> Result<DeviceNameRow, AppError>
where
    C: ConnectionTrait,
{
    let device_name = device_name::ActiveModel {
        id: NotSet,
        name: Set(Some(name.clone())),
        login_id: Set(login),
        created_at: NotSet,
        search_tsv: NotSet,
    };
    let device_name = device_name::Entity::insert(device_name)
        .exec(dbx)
        .await
        .c(h!())?;
    Ok(DeviceNameRow {
        id: device_name.last_insert_id,
        name: Some(name),
    })
}

fn select_device_name() -> Select<device_name::Entity> {
    device_name::Entity::find()
        .select_only()
        .column(device_name::Column::Id)
        .column(device_name::Column::Name)
}

fn render_device_name_row((id, name): (i64, Option<String>)) -> DeviceNameRow {
    DeviceNameRow { id, name }
}

pub async fn search<C>(
    dbx: &C,
    search_phrase: &str,
) -> Result<Vec<DeviceNameRow>, AppError>
where
    C: ConnectionTrait,
{
    let mut query =
        select_device_name().filter(device_name::Column::Name.is_not_null());

    if !search_phrase.is_empty() {
        query = query.filter(Expr::cust_with_values(
            "search_tsv @@ websearch_to_tsquery('simple', $1) OR lower(\"device_name\".\"name\") LIKE lower($2) ESCAPE '\\'",
            vec![
                search_phrase.to_string(),
                format!("%{}%", escape_like(search_phrase)),
            ],
        ));
    }

    Ok(query
        .order_by_asc(device_name::Column::Name)
        .limit(DEVICE_NAME_SEARCH_LIMIT)
        .into_tuple::<(i64, Option<String>)>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(render_device_name_row)
        .collect())
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
