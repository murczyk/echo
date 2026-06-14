use crate::entities::{
    datasource, datasource_group, signal_group, signal_message_metadata,
    signal_profile,
};
use crate::error::AppError;
use crate::h;
use crate::messenger::types::Message;
use crate::types::Env;
use crate::types::ShortContext;
use crate::utils::orm::ArrayColumnOps;
use actix_web::post;
use actix_web::web::Json;
use chrono::Utc;
use echo_im::types::MessageAttachmentF1;
use sea_orm::*;

pub mod oneoff;
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

    let group_master_key = group
        .source_signal_group_id
        .or(group.source_whatsapp_group_jid);

    let keys = if let Some(master_key) = &group_master_key {
        vec![echo_id.clone(), master_key.clone()]
    } else {
        vec![echo_id.clone()]
    };

    let signal_group_candidates = signal_group::Entity::find()
        .filter(
            Condition::any()
                .add(signal_group::Column::Name.eq(group.name.clone()))
                .add(signal_group::Column::MasterKey.eq_any(keys.clone())),
        )
        .all(txn)
        .await
        .c(h!())?;

    let datasource_group_candidates = datasource_group::Entity::find()
        .filter(datasource_group::Column::DatasourceId.eq(datasource_id))
        .filter(
            Condition::any()
                .add(datasource_group::Column::Name.eq(group.name.clone()))
                .add(datasource_group::Column::GroupMasterKey.eq_any(keys)),
        )
        .all(txn)
        .await
        .c(h!())?;

    let signal_group_by_master_key =
        if let Some(group_master_key) = &group_master_key {
            signal_group_candidates
                .iter()
                .find(|x| &x.master_key == group_master_key)
        } else {
            None
        };

    let signal_group_by_echo_id = signal_group_candidates
        .iter()
        .find(|x| x.master_key == echo_id);

    let datasource_group_by_group_master_key =
        if let Some(group_master_key) = &group_master_key {
            datasource_group_candidates
                .iter()
                .find(|x| &x.group_master_key == group_master_key)
        } else {
            None
        };

    let datasource_group_by_echo_id = datasource_group_candidates
        .iter()
        .find(|x| x.group_master_key == echo_id);

    let signal_group_by_name = signal_group_candidates
        .iter()
        .find(|x| x.name.as_ref() == Some(&group.name));

    let datasource_group_by_name = datasource_group_candidates
        .iter()
        .find(|x| x.name == group.name);

    let result = if let Some(datasource_group_by_group_master_key) =
        datasource_group_by_group_master_key
    {
        sync_datasource_group(
            txn,
            datasource_group_by_group_master_key,
            signal_group_by_master_key,
            &group.name,
        )
        .await
        .c(h!())?
    } else if let Some(datasource_group_by_echo_id) =
        datasource_group_by_echo_id
    {
        sync_datasource_group(
            txn,
            datasource_group_by_echo_id,
            signal_group_by_echo_id,
            &group.name,
        )
        .await
        .c(h!())?
    } else if let Some(datasource_group_by_name) = datasource_group_by_name {
        datasource_group_by_name.clone()
    } else {
        insert_datasource_group(
            txn,
            datasource_id,
            echo_id,
            &group.name,
            group_master_key,
            signal_group_by_master_key,
            signal_group_by_echo_id,
            signal_group_by_name,
        )
        .await
        .c(h!())?
    };

    Ok(result.group_master_key)
}

async fn sync_datasource_group(
    txn: &DatabaseTransaction,
    model: &datasource_group::Model,
    signal_group: Option<&signal_group::Model>,
    group_name: &str,
) -> anyhow::Result<datasource_group::Model> {
    if let Some(signal_group) = signal_group {
        sync_signal_group(txn, model.datasource_id, signal_group, group_name)
            .await
            .c(h!())?;
    }

    if model.deleted || model.name != group_name {
        let mut active_model = model.clone().into_active_model();
        active_model.deleted = Set(false);
        active_model.name = Set(group_name.to_string());
        active_model.last_sync_at = Set(Utc::now().naive_utc());
        let model = active_model.update(txn).await.c(h!())?;
        Ok(model)
    } else {
        Ok(model.clone())
    }
}

async fn sync_signal_group(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    signal_group: &signal_group::Model,
    group_name: &str,
) -> anyhow::Result<signal_group::Model> {
    let signal_group_name = signal_group.name.as_deref();

    if signal_group.datasource_id == Some(datasource_id)
        && (signal_group.deleted || signal_group_name != Some(group_name))
    {
        let mut active_model = signal_group.clone().into_active_model();
        active_model.deleted = Set(false);
        active_model.name = Set(Some(group_name.to_string()));
        let model = active_model.update(txn).await.c(h!())?;
        Ok(model)
    } else {
        Ok(signal_group.clone())
    }
}

async fn insert_datasource_group(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    echo_id: String,
    group_name: &str,
    group_master_key: Option<String>,
    signal_group_by_master_key: Option<&signal_group::Model>,
    signal_group_by_echo_id: Option<&signal_group::Model>,
    signal_group_by_name: Option<&signal_group::Model>,
) -> anyhow::Result<datasource_group::Model> {
    let signal_group = if let Some(by_master_key) = signal_group_by_master_key {
        sync_signal_group(txn, datasource_id, by_master_key, group_name)
            .await
            .c(h!())?
    } else if let Some(by_echo_id) = signal_group_by_echo_id {
        sync_signal_group(txn, datasource_id, by_echo_id, group_name)
            .await
            .c(h!())?
    } else if let Some(by_name) = signal_group_by_name {
        sync_signal_group(txn, datasource_id, by_name, group_name)
            .await
            .c(h!())?
    } else {
        let master_key = group_master_key.unwrap_or(echo_id);
        let model = signal_group::ActiveModel {
            master_key: Set(master_key),
            name: Set(Some(group_name.to_string())),
            datasource_id: Set(Some(datasource_id)),
            ..Default::default()
        };
        model.insert(txn).await.c(h!())?
    };

    let model = datasource_group::ActiveModel {
        datasource_id: Set(datasource_id),
        group_master_key: Set(signal_group.master_key),
        name: Set(group_name.to_string()),
        ..Default::default()
    };

    let datasource_group = model.insert(txn).await.c(h!())?;

    Ok(datasource_group)
}

fn mk_echo_id(id: String) -> String {
    format!("echo.{id}")
}
