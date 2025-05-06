use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use sea_orm::*;

pub async fn get_kv<'a, A>(
    dbx: &sea_orm::DatabaseConnection,
    k: &str,
) -> Result<Option<A>, AppError>
where
    A: for<'de> serde::Deserialize<'de>,
{
    let existing_kv: Option<delta_kv::Model> = delta_kv::Entity::find()
        .filter(delta_kv::Column::K.eq(k.to_string()))
        .one(dbx)
        .await?;
    match existing_kv {
        None => Ok(None),
        Some(kv) => {
            Ok(Some(serde_json::from_value(kv.v.clone()).context(h!())?))
        }
    }
}

pub async fn put_kv<V>(
    dbx: &sea_orm::DatabaseConnection,
    k: &str,
    v: V,
) -> Result<(), AppError>
where
    V: serde::Serialize + Clone,
{
    let existing_kv: Option<delta_kv::Model> = delta_kv::Entity::find()
        .filter(delta_kv::Column::K.eq(k.to_string()))
        .one(dbx)
        .await?;
    match existing_kv {
        None => {
            delta_kv::ActiveModel {
                id: NotSet,
                k: Set(k.to_string()),
                v: Set(serde_json::to_value(v.clone()).context(h!())?),
            }
            .insert(dbx)
            .await?;
        }
        Some(kv) => {
            let mut kv: delta_kv::ActiveModel = kv.into();
            kv.v = Set(serde_json::to_value(v.clone()).context(h!())?);
            kv.update(dbx).await?;
        }
    }
    Ok(())
}
