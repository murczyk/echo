use crate::entities::{
    datasource, datasource_group, group_admin_data, login, organism_group,
    secret_group_user, sigint_zone_datasource, signal_group, signal_group_aor,
    signal_message_group, signal_message_metadata, signal_profile,
};
use crate::error::AppError;
use crate::h;
use crate::messenger::types::Message;
use crate::types::Env;
use crate::types::ShortContext;
use crate::users::{has_role, login_id_from_identity};
use actix_web::post;
use actix_web::web::Json;
use chrono::Utc;
use echo_im::types::MessageAttachmentF1;
use sea_orm::*;
use sea_query::Expr;

const ECHO_OPERATOR_LABEL_PREFIX: &str = "EХО Оператор ";

pub mod oneoff;
mod types;
pub mod worker;

#[post("/api/echo-operator/message/submit")]
async fn message_submit(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<types::OperatorInboxMessage>,
) -> Result<Json<types::SubmitMessageRsp>, AppError> {
    has_role(&env.dbx, &login_id_from_identity(&user)?, "Api")
        .await
        .c(h!())?;
    let login_id = login_id_from_identity(&user)?;

    let txn = env.dbx.begin().await.c(h!())?;
    let datasource = ensure_api_datasource(&login_id, &txn).await.c(h!())?;
    let mut changed_inbox_item_ids = vec![];
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
        let signal_message_result =
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
                &mut changed_inbox_item_ids,
            )
            .await
            .c(h!())?;
        let signal_message_uid = signal_message_result.message_uid;

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
    crate::inbox::fanout_inbox_changes(
        &mut env.redis.clone(),
        changed_inbox_item_ids,
    )
    .await
    .c(h!())?;
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
    login_id: &uuid::Uuid,
    txn: &DatabaseTransaction,
) -> Result<datasource::Model, AppError> {
    let now = chrono::Utc::now().naive_utc();
    let login_name = login::Entity::find_by_id(*login_id)
        .select_only()
        .column(login::Column::Login)
        .into_tuple::<String>()
        .one(txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;
    let display_name = format!("{ECHO_OPERATOR_LABEL_PREFIX}{login_name}");

    let maybe_datasource = datasource::Entity::find()
        .filter(datasource::Column::ApiLoginId.eq(*login_id))
        .filter(datasource::Column::Kind.eq("echo_operator"))
        .one(txn)
        .await
        .c(h!())?;
    if let Some(mut datasource) = maybe_datasource {
        let mut needs_update = false;
        let mut updated_datasource = datasource.clone().into_active_model();

        if datasource.display_name != display_name {
            updated_datasource.display_name = Set(display_name);
            needs_update = true;
        }
        if datasource.deleted {
            // ressurect but not re-enable datasource
            updated_datasource.deleted = Set(false);
            needs_update = true;
            if datasource.enabled != Some(false) {
                updated_datasource.enabled = Set(Some(false));
                needs_update = true;
            }
            if datasource.updated_by_login_id != Some(*login_id) {
                updated_datasource.updated_by_login_id = Set(Some(*login_id));
                needs_update = true;
            }
        }

        if datasource.last_sync_at != Some(now) {
            updated_datasource.last_sync_at = Set(Some(now));
            needs_update = true;
        }

        if needs_update {
            datasource = updated_datasource.update(txn).await.c(h!())?;
        }
        Ok(datasource)
    } else {
        let new_datasource = datasource::ActiveModel {
            kind: Set("echo_operator".to_string()),
            display_name: Set(display_name),
            enabled: Set(Some(true)),
            api_login_id: Set(Some(*login_id)),
            updated_by_login_id: Set(Some(*login_id)),
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
        Some(nm) => profile.name == *nm,
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
    let group_master_key = source_group_key(&group);
    let echo_id = mk_echo_id(group.id);

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
    } else if let (Some(group_master_key), Some(datasource_group_by_echo_id)) =
        (&group_master_key, datasource_group_by_echo_id)
    {
        move_datasource_group_to_source_group(
            txn,
            datasource_group_by_echo_id,
            group_master_key,
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
        let owned_signal_group = signal_group::Entity::find()
            .filter(
                signal_group::Column::MasterKey
                    .eq(datasource_group_by_name.group_master_key.clone()),
            )
            .filter(signal_group::Column::DatasourceId.eq(datasource_id))
            .one(txn)
            .await
            .c(h!())?;
        if let Some(signal_group) = owned_signal_group {
            sync_signal_group(txn, datasource_id, &signal_group, &group.name)
                .await
                .c(h!())?;
        }
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

fn source_group_key(group: &types::Group) -> Option<String> {
    group
        .source_signal_group_id
        .as_deref()
        .and_then(non_empty_source_key)
        .or_else(|| {
            group
                .source_whatsapp_group_jid
                .as_deref()
                .and_then(non_empty_source_key)
        })
        .map(str::to_owned)
}

fn non_empty_source_key(key: &str) -> Option<&str> {
    let key = key.trim();
    (!key.is_empty()).then_some(key)
}

async fn move_datasource_group_to_source_group(
    txn: &DatabaseTransaction,
    datasource_group: &datasource_group::Model,
    group_master_key: &str,
    signal_group: Option<&signal_group::Model>,
    group_name: &str,
) -> anyhow::Result<datasource_group::Model> {
    let fallback_signal_group = signal_group::Entity::find_by_id(
        datasource_group.group_master_key.clone(),
    )
    .one(txn)
    .await
    .c(h!())?
    .c(h!())?;
    let signal_group = ensure_source_signal_group(
        txn,
        datasource_group.datasource_id,
        group_master_key,
        signal_group,
        group_name,
    )
    .await
    .c(h!())?;

    let mut datasource_group = datasource_group.clone().into_active_model();
    datasource_group.group_master_key = Set(signal_group.master_key.clone());
    datasource_group.deleted = Set(false);
    datasource_group.name = Set(group_name.to_string());
    datasource_group.last_sync_at = Set(Utc::now().naive_utc());
    let datasource_group = datasource_group.update(txn).await.c(h!())?;

    merge_signal_group_references(
        txn,
        datasource_group.id,
        fallback_signal_group,
        &signal_group,
    )
    .await
    .c(h!())?;

    Ok(datasource_group)
}

async fn merge_signal_group_references(
    txn: &DatabaseTransaction,
    datasource_group_id: i64,
    source_signal_group: signal_group::Model,
    target_signal_group: &signal_group::Model,
) -> anyhow::Result<()> {
    signal_message_group::Entity::update_many()
        .filter(
            signal_message_group::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .filter(
            signal_message_group::Column::DatasourceGroupId
                .eq(datasource_group_id),
        )
        .col_expr(
            signal_message_group::Column::GroupMasterKey,
            Expr::value(target_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    group_admin_data::Entity::delete_many()
        .filter(
            group_admin_data::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    organism_group::Entity::delete_many()
        .filter(
            organism_group::Column::SignalGroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    secret_group_user::Entity::delete_many()
        .filter(
            secret_group_user::Column::MasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    sigint_zone_datasource::Entity::delete_many()
        .filter(
            sigint_zone_datasource::Column::GroupMasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    signal_group_aor::Entity::delete_many()
        .filter(
            signal_group_aor::Column::MasterKey
                .eq(source_signal_group.master_key.clone()),
        )
        .exec(txn)
        .await
        .c(h!())?;

    crate::battle_line::requeue_settlement_links_for_group(
        txn,
        &source_signal_group.master_key,
    )
    .await
    .c(h!())?;
    crate::battle_line::requeue_settlement_links_for_group(
        txn,
        &target_signal_group.master_key,
    )
    .await
    .c(h!())?;

    let mut source_signal_group = source_signal_group.into_active_model();
    source_signal_group.deleted = Set(true);
    source_signal_group.update(txn).await.c(h!())?;

    Ok(())
}

async fn ensure_source_signal_group(
    txn: &DatabaseTransaction,
    datasource_id: i64,
    group_master_key: &str,
    signal_group: Option<&signal_group::Model>,
    group_name: &str,
) -> anyhow::Result<signal_group::Model> {
    if let Some(signal_group) = signal_group {
        return sync_signal_group(txn, datasource_id, signal_group, group_name)
            .await
            .c(h!());
    }

    signal_group::ActiveModel {
        master_key: Set(group_master_key.to_string()),
        name: Set(Some(group_name.to_string())),
        datasource_id: Set(Some(datasource_id)),
        ..Default::default()
    }
    .insert(txn)
    .await
    .c(h!())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::signal_message;
    use crate::functest::tests::{
        cleanup, mk_datasource, mk_datasource_group, mk_signal_group,
        mk_signal_message, mk_signal_message_group,
    };
    use serial_test::serial;

    #[test]
    fn source_group_key_ignores_blank_values() {
        let group = types::Group {
            id: "operator-group".to_string(),
            name: "BBC NEWS".to_string(),
            source_signal_group_id: Some(" ".to_string()),
            source_whatsapp_group_jid: Some(
                "120363419907122319@g.us".to_string(),
            ),
        };

        assert_eq!(
            source_group_key(&group).as_deref(),
            Some("120363419907122319@g.us")
        );
    }

    #[tokio::test]
    #[serial]
    // Regression: https://github.com/echoua/echo/issues/3391
    async fn ensure_group_moves_existing_echo_mapping_and_messages() {
        let env = cleanup().await.unwrap();
        let txn = env.dbx.begin().await.unwrap();
        let group_name = "BBC NEWS";
        let source_group_key = "120363419907122319@g.us";
        let operator_group_id = "019ebab3-d6e8-7ff6-b662-004ee7394520";
        let echo_group_key = mk_echo_id(operator_group_id.to_string());
        let messenger_datasource = mk_datasource(
            &txn,
            datasource::ActiveModel {
                kind: Set("whatsapp".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let operator_datasource = mk_datasource(
            &txn,
            datasource::ActiveModel {
                kind: Set("echo_operator".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let source_signal_group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(source_group_key.to_string()),
                name: Set(Some(group_name.to_string())),
                datasource_id: Set(Some(messenger_datasource.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let fallback_signal_group = mk_signal_group(
            &txn,
            signal_group::ActiveModel {
                master_key: Set(echo_group_key.clone()),
                name: Set(Some(group_name.to_string())),
                datasource_id: Set(Some(operator_datasource.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let fallback_datasource_group = mk_datasource_group(
            &txn,
            datasource_group::ActiveModel {
                datasource_id: Set(operator_datasource.id),
                group_master_key: Set(echo_group_key.clone()),
                name: Set(group_name.to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let historical_message = mk_signal_message(
            &txn,
            signal_message::ActiveModel {
                datasource_group_id: Set(Some(fallback_datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let historical_message_group = mk_signal_message_group(
            &txn,
            signal_message_group::ActiveModel {
                signal_message_id: Set(historical_message.id),
                group_master_key: Set(Some(echo_group_key.clone())),
                datasource_group_id: Set(Some(fallback_datasource_group.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let resolved_group_key = ensure_group(
            operator_datasource.id,
            &txn,
            types::Group {
                id: operator_group_id.to_string(),
                name: group_name.to_string(),
                source_signal_group_id: Some("".to_string()),
                source_whatsapp_group_jid: Some(source_group_key.to_string()),
            },
        )
        .await
        .unwrap();
        let datasource_group =
            datasource_group::Entity::find_by_id(fallback_datasource_group.id)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        let source_signal_group =
            signal_group::Entity::find_by_id(source_signal_group.master_key)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        let fallback_signal_group =
            signal_group::Entity::find_by_id(fallback_signal_group.master_key)
                .one(&txn)
                .await
                .unwrap()
                .unwrap();
        let historical_message_group =
            signal_message_group::Entity::find_by_id(
                historical_message_group.id,
            )
            .one(&txn)
            .await
            .unwrap()
            .unwrap();

        assert_eq!(resolved_group_key, source_group_key);
        assert_eq!(datasource_group.group_master_key, source_group_key);
        assert_eq!(datasource_group.datasource_id, operator_datasource.id);
        assert_eq!(
            historical_message_group.group_master_key.as_deref(),
            Some(source_group_key)
        );
        assert!(fallback_signal_group.deleted);
        assert_eq!(
            source_signal_group.datasource_id,
            Some(messenger_datasource.id)
        );
    }
}
