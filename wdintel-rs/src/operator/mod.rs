use crate::entities::{
    datasource, datasource_group, signal_group, signal_message_metadata,
    signal_profile,
};
use crate::error::AppError;
use crate::h;
use crate::messenger::types::Message;
use crate::types::Env;
use crate::types::ShortContext;
use actix_web::post;
use actix_web::web::Json;
use chrono::Utc;
use echo_im::types::MessageAttachmentF1;
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

    let txn = env.dbx.begin().await.c(h!())?;
    let datasource = ensure_api_datasource(&login, &txn).await.c(h!())?;
    let message_uid = if datasource.enabled.unwrap_or(false) {
        let sender_id =
            ensure_profile(&txn, req.profile.clone()).await.c(h!())?;
        let group_master_key =
            ensure_group(datasource.id, &txn, req.group.clone())
                .await
                .c(h!())?;
        let timestamp = Utc::now().naive_utc();

        let message = Message {
            body: req.message.to_owned(),
            group_id: group_master_key,
            sender: Some(sender_id),
            timestamp,
            datasource_id: datasource.id,
            inbox_message_id: None,
        };
        let signal_message_uid =
            crate::message_queue::process_signal_message_queue_item(
                message,
                Vec::<MessageAttachmentF1>::new(),
                &mut env.redis.clone(),
                env.settlements.clone(),
                &env.rq,
                &env.config,
                &env.s3,
                &txn,
                true,
            )
            .await
            .c(h!())?;

        let types::OperatorInboxMessage {
            instance_id,
            metadata,
            ..
        } = req.0;

        enqueue_message_dmr_metadata(
            &signal_message_uid,
            instance_id,
            metadata,
            &txn,
        )
        .await
        .c(h!())?;

        signal_message_uid
    } else {
        Default::default()
    };

    txn.commit().await.c(h!())?;
    Ok(Json(types::SubmitMessageRsp { message_uid }))
}

async fn enqueue_message_dmr_metadata(
    message_uid: &str,
    instance_id: String,
    metadata: types::Metadata,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    if metadata.dmr_sender_id.is_some()
        || metadata.dmr_call_group_id.is_some()
        || metadata.dmr_color_code.is_some()
    {
        let model = signal_message_metadata::ActiveModel {
            instance_id: Set(instance_id),
            message_uid: Set(message_uid.to_string()),
            dmr_sender_id: Set(metadata.dmr_sender_id),
            dmr_call_group_id: Set(metadata.dmr_call_group_id),
            dmr_color_code: Set(metadata.dmr_color_code),
            ..Default::default()
        };

        model.insert(txn).await.c(h!())?;
    }

    Ok(())
}

async fn ensure_api_datasource(
    login: &str,
    txn: &DatabaseTransaction,
) -> Result<datasource::Model, AppError> {
    let now = chrono::Utc::now().naive_utc();
    let maybe_datasource = datasource::Entity::find()
        .filter(datasource::Column::ApiLogin.eq(login))
        .filter(datasource::Column::Kind.eq("echo_operator"))
        .one(txn)
        .await
        .c(h!())?;
    if let Some(mut datasource) = maybe_datasource {
        let is_deleted = datasource.deleted;
        let mut updated_datasource = datasource.into_active_model();
        if is_deleted {
            // ressurect but not re-enable datasource
            updated_datasource.deleted = Set(false);
            updated_datasource.updated_by = Set(Some(login.to_string()));
            updated_datasource.enabled = Set(Some(false));
        } else {
            updated_datasource.last_sync_at = Set(Some(now));
        }
        datasource = updated_datasource.update(txn).await.c(h!())?;
        Ok(datasource)
    } else {
        let new_datasource = datasource::ActiveModel {
            kind: Set("echo_operator".to_string()),
            display_name: Set(format!("EХО Оператор {login}")),
            enabled: Set(Some(true)),
            api_login: Set(Some(login.to_string())),
            updated_by: Set(Some(login.to_string())),
            last_sync_at: Set(Some(now)),
            deleted: Set(false),
            ..Default::default()
        };
        let datasource = new_datasource.insert(txn).await.c(h!())?;
        Ok(datasource)
    }
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

    let exact_group = signal_group::Entity::find_by_id(echo_id.clone())
        .filter(signal_group::Column::DatasourceId.eq(datasource_id))
        .filter(signal_group::Column::Deleted.eq(false))
        .one(txn)
        .await
        .c(h!())?;

    if let Some(exact_group) = exact_group {
        let datasource_group = datasource_group::Entity::find()
            .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
            .filter(
                datasource_group::Column::GroupMasterKey.eq(echo_id.clone()),
            )
            .filter(datasource_group::Column::Deleted.eq(false))
            .one(txn)
            .await
            .c(h!())?;

        if let Some(d) = datasource_group {
            if exact_group.name.as_ref() != Some(&group.name) {
                let mut model = exact_group.into_active_model();
                model.name = Set(Some(group.name.clone()));
                model.update(txn).await.c(h!())?;

                let mut rec = d.into_active_model();
                rec.last_sync_at = Set(Utc::now().naive_utc());
                rec.update(txn).await.c(h!())?;
            }
        } else {
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
        Ok(echo_id)
    } else {
        let related_group_by_name = datasource_group::Entity::find()
            .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
            .filter(datasource_group::Column::Name.eq(group.name.clone()))
            .filter(datasource_group::Column::Deleted.eq(false))
            .one(txn)
            .await
            .c(h!())?;

        if let Some(g) = related_group_by_name {
            Ok(g.group_master_key)
        } else {
            let signal_groups_by_name = signal_group::Entity::find()
                .filter(signal_group::Column::Name.eq(group.name.clone()))
                .filter(signal_group::Column::Deleted.eq(false))
                .all(txn)
                .await
                .c(h!())?;

            let group_master_key = match signal_groups_by_name.as_slice() {
                [single] => {
                    log::warn!(
                        "found a single group with name '{}', attaching group {} to datasource {}",
                        &group.name,
                        &single.master_key,
                        datasource_id
                    );
                    single.master_key.clone()
                }
                _ => {
                    log::warn!(
                        "found {} groups with name '{}', creating a new group {} to datasource {}",
                        signal_groups_by_name.len(),
                        &group.name,
                        &echo_id,
                        datasource_id
                    );
                    let model = signal_group::ActiveModel {
                        master_key: Set(echo_id.clone()),
                        name: Set(Some(group.name.clone())),
                        datasource_id: Set(Some(datasource_id)),
                        created_at: NotSet,
                        ignore_operativny: NotSet,
                        is_secret: NotSet,
                        deleted: NotSet,
                    };
                    model.insert(txn).await.c(h!())?;
                    echo_id
                }
            };

            datasource_group::ActiveModel {
                id: NotSet,
                group_master_key: Set(group_master_key.clone()),
                datasource_id: Set(datasource_id),
                last_sync_at: NotSet,
                created_at: NotSet,
                name: Set(group.name),
                deleted: NotSet,
            }
            .insert(txn)
            .await
            .c(h!())?;

            Ok(group_master_key)
        }
    }
}

fn mk_echo_id(id: String) -> String {
    format!("echo.{id}")
}
