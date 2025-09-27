use crate::entities::{
    datasource, datasource_group, signal_group, signal_profile,
};
use crate::error::AppError;
use crate::h;
use crate::messenger::types::Message;
use crate::types::Env;
use crate::types::ShortContext;
use actix_web::post;
use actix_web::web::{Data, Json};
use chrono::Utc;
use sea_orm::*;

mod types;
pub mod worker;

#[post("/api/echo-operator/message/submit")]
async fn message_submit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<types::OperatorInboxMessage>,
) -> Result<Json<types::SubmitMessageRsp>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Api")
        .await
        .c(h!())?;
    let datasource_id = load_api_datasource(&env, &login).await.c(h!())?;
    let txn = env.dbx.begin().await.c(h!())?;
    let sender_id = ensure_profile(&txn, req.profile.clone()).await.c(h!())?;
    let group_master_key = ensure_group(datasource_id, &txn, req.group.clone())
        .await
        .c(h!())?;
    let timestamp = chrono::DateTime::from_timestamp_millis(req.timestamp)
        .c(h!())?
        .naive_utc();

    let message = Message {
        body: req.message.to_owned(),
        group_id: group_master_key,
        sender: Some(sender_id),
        timestamp,
        datasource_id,
    };
    let message_uid = crate::messenger::worker::receive_once(
        message,
        vec![],
        &mut env.redis.clone(),
        env.settlements.clone(),
        &env.rq,
        &env.config,
        &txn,
        true,
    )
    .await
    .c(h!())?;
    txn.commit().await.c(h!())?;
    Ok(Json(types::SubmitMessageRsp { message_uid }))
}

async fn load_api_datasource(
    env: &Data<Env>,
    login: &String,
) -> anyhow::Result<i64> {
    let id = datasource::Entity::find()
        .filter(datasource::Column::ApiLogin.eq(login))
        .filter(datasource::Column::Kind.eq("echo_operator"))
        .select_only()
        .column(datasource::Column::Id)
        .into_tuple::<i64>()
        .one(&env.dbx)
        .await
        .c(h!())?;
    id.c(h!())
}

async fn ensure_profile(
    txn: &DatabaseTransaction,
    profile: types::Profile,
) -> anyhow::Result<String> {
    let echo_id = mk_echo_id(profile.id);
    let old_name = signal_profile::Entity::find_by_id(echo_id.clone())
        .select_only()
        .column(signal_profile::Column::GivenName)
        .into_tuple::<String>()
        .one(txn)
        .await
        .c(h!())?;
    let already_exists = old_name.is_some();
    let up_to_date = match &old_name {
        None => false,
        Some(nm) => profile.name.eq(nm),
    };
    if already_exists && up_to_date {
        return Ok(echo_id);
    }
    let model = signal_profile::ActiveModel {
        uuid: Set(echo_id.clone()),
        given_name: Set(Some(profile.name)),
        family_name: Set(None),
        created_at: NotSet,
    };
    if already_exists {
        model.update(txn).await.c(h!())?;
    } else {
        model.insert(txn).await.c(h!())?;
    }
    Ok(echo_id)
}

async fn ensure_group(
    datasource_id: i64,
    txn: &DatabaseTransaction,
    group: types::Group,
) -> anyhow::Result<String> {
    let echo_id = mk_echo_id(group.id);
    let old_name = signal_group::Entity::find_by_id(echo_id.clone())
        .filter(signal_group::Column::DatasourceId.eq(datasource_id))
        .select_only()
        .column(signal_group::Column::Name)
        .into_tuple::<String>()
        .one(txn)
        .await
        .c(h!())?;
    let already_exists = old_name.is_some();
    let up_to_date = match &old_name {
        None => false,
        Some(nm) => group.name.eq(nm),
    };
    if already_exists && up_to_date {
        return Ok(echo_id);
    }
    let model = signal_group::ActiveModel {
        master_key: Set(echo_id.clone()),
        name: Set(Some(group.name.clone())),
        datasource_id: Set(Some(datasource_id)),
        created_at: NotSet,
        ignore_operativny: NotSet,
        is_secret: NotSet,
        deleted: NotSet,
    };
    if already_exists {
        model.update(txn).await.c(h!())?;
    } else {
        model.insert(txn).await.c(h!())?;
    }
    let datasource_groups = datasource_group::Entity::find()
        .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
        .filter(datasource_group::Column::GroupMasterKey.eq(echo_id.clone()))
        .one(txn)
        .await
        .c(h!())?;
    match datasource_groups {
        Some(d) => {
            let mut rec = d.into_active_model();
            rec.last_sync_at = Set(Utc::now().naive_utc());
            rec.update(txn).await.c(h!())?;
        }
        None => {
            datasource_group::ActiveModel {
                id: NotSet,
                group_master_key: Set(echo_id.clone()),
                datasource_id: Set(datasource_id),
                last_sync_at: NotSet,
                created_at: NotSet,
                name: Set(group.name),
                deleted: NotSet,
            }
            .insert(txn)
            .await
            .c(h!())?;
        }
    }
    Ok(echo_id)
}

fn mk_echo_id(id: String) -> String {
    format!("echo.{id}")
}
