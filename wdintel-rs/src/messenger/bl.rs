use crate::config::*;
use crate::entities::area_of_responsibility::Model;
use crate::entities::sea_orm_active_enums::AccountStatus;
use crate::entities::*;
use crate::error::ContextAndError;
use crate::messenger::types::EchoAccountF1;
use crate::sigint::area_of_responsibility::render_aor;
use crate::types::AppError;
use crate::types::*;
use echo_im::entities::sea_orm_active_enums::{
    EchoMessageSource, SignalCliMode,
};
use echo_im::os_specific;
use echo_im::types::MessageSource;
use sea_orm::prelude::DateTime;
use sea_orm::*;
use std::net::TcpListener;

pub async fn load_echo_account(
    id: i64,
    txn: &DatabaseTransaction,
) -> Result<EchoAccountF1, AppError> {
    let account = list_accounts(txn)
        .await
        .context(h!())?
        .into_iter()
        .filter(|a| a.id == id)
        .next()
        .context(h!())?;
    Ok(account)
}

pub async fn edit_account(
    id: i64,
    aor_id: Option<i64>,
    set_active: bool,
    display_name: String,
    description: Option<String>,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let account = load_echo_account(id, txn).await.context(h!())?;
    let status =
        AccountStatus::try_from_value(&account.status).context(h!())?;
    let is_active = status == AccountStatus::Active;
    info!("account={id}, set_active={set_active}");
    if set_active == is_active {
        warn!("nothing to do, skipping");
        return Ok(());
    }
    let new_status = if set_active {
        AccountStatus::Active
    } else {
        AccountStatus::Paused
    };
    let mut account = datasource::Entity::find_by_id(id)
        .one(txn)
        .await
        .context(h!())?
        .context(h!())?
        .into_active_model();
    account.default_aor_id = Set(aor_id);
    account.display_name = Set(display_name);
    account.description = Set(description);
    account.status = Set(new_status);
    account.update(txn).await.context(h!())?;
    Ok(())
}

pub async fn deactivate_account(
    id: i64,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let account = load_echo_account(id, txn).await.context(h!())?;
    let messenger =
        EchoMessageSource::try_from_value(&account.messenger).context(h!())?;
    let service_name = account.system_service_name.context(h!())?;
    match messenger {
        EchoMessageSource::Signal => os_specific::stop_signal_client(
            &service_name,
            SIGNAL_CLIENT_DIR,
            SIGNAL_UNIT_NAME,
        )
        .await
        .context(h!())?,
        EchoMessageSource::Whatsapp => os_specific::stop_whatsapp_client(
            &service_name,
            WHATSAPP_CLIENT_DIR,
            WHATSAPP_UNIT_NAME,
        )
        .await
        .context(h!())?,
    };
    datasource::Entity::delete_by_id(account.id)
        .exec(txn)
        .await
        .context(h!())?;
    Ok(())
}

pub async fn link_account(
    phone_number: &str,
    display_name: &str,
    system_service_name: &str,
    source: &str,
    description: Option<String>,
    aor_id: i64,
    txn: &DatabaseTransaction,
) -> Result<EchoAccountF1, AppError> {
    if !is_valid_service_name(&system_service_name) {
        return Err(AppError::BL {
            msg: format!("Invalid system service name: {system_service_name}"),
        });
    }
    let source =
        EchoMessageSource::try_from_value(&source.to_string()).context(h!())?;

    let (src, src_name) = match &source {
        EchoMessageSource::Signal => {
            (echo_im::types::MessageSource::Signal, SIGNAL_UNIT_NAME)
        }
        EchoMessageSource::Whatsapp => {
            (echo_im::types::MessageSource::Whatsapp, WHATSAPP_UNIT_NAME)
        }
    };
    let unit_name = format!("{src_name}@{display_name}");
    let accounts = list_accounts(txn).await.context(h!())?;
    let existing_account = accounts
        .into_iter()
        .filter(|a| {
            a.system_service_name
                .clone()
                .map(|s| s.eq(system_service_name))
                .is_some()
        })
        .filter(|a| a.phone_number.eq(phone_number))
        .filter(|a| a.messenger.eq(&src_name))
        .into_iter()
        .next();

    if let Some(acc) = existing_account {
        let msg = format!("Номером телефону {} вже прив'язано", phone_number);
        error!("{}: {:?}", msg, acc);
        return Err(AppError::BL { msg });
    }

    let port = find_port_available(8010, 9000).await.context(h!())?;
    let src_display_name = src.to_string().to_lowercase();
    let attachment_path = format!(
        "/etc/echo/{}-cli-data/{}/{}-cli/attachments/",
        src_display_name, system_service_name, src_display_name
    );
    info!("attachment path created: {attachment_path}");
    echo_im::attach_new_client(
        system_service_name,
        &attachment_path,
        unit_name,
        port,
        txn,
        SignalCliMode::Native,
    )
    .await
    .map_err(|res| {
        warn!("AppError: {:?}", res.to_string());
        AppError::BL {
            msg: format!("{:?}", res),
        }
    })
    .cae(h!())?;

    let lock = echo_im::set_account_phone(
        String::from(phone_number),
        &system_service_name,
        src.clone(),
        true,
        txn,
    )
    .await
    .cae(h!())?;

    let id = datasource::ActiveModel {
        echo_client_lock_id: Set(Some(lock.id as i64)),
        id: NotSet,
        status: NotSet,
        created_at: NotSet,
        display_name: Set(display_name.to_string()),
        signal_phone: NotSet,
        signal_docker_port: NotSet,
        api_endpoint: NotSet,
        enabled: NotSet,
        group_master_key: NotSet,
        sender_uuid: NotSet,
        description: Set(description),
        kind: Set(src_display_name),
        default_aor_id: Set(Some(aor_id)),
    }
    .insert(txn)
    .await
    .context(h!())?
    .id;

    match src {
        MessageSource::Signal => os_specific::start_new_signal_client(
            &system_service_name,
            port,
            SIGNAL_CLIENT_DIR,
            SIGNAL_UNIT_NAME,
            CLIENT_DATA_DIR_NAME,
            &SignalCliMode::Native,
        )
        .await
        .context(h!())?,
        MessageSource::Whatsapp => os_specific::start_new_whatsapp_client(
            &system_service_name,
            WHATSAPP_CLIENT_CONFIG,
            WHATSAPP_CLIENT_DIR,
            WHATSAPP_UNIT_NAME,
            CLIENT_DATA_DIR_NAME,
        )
        .await
        .context(h!())?,
    };

    load_echo_account(id, txn).await
}

pub async fn get_qr_code(
    account_id: i64,
    txn: &DatabaseTransaction,
) -> Result<String, AppError> {
    let account = list_accounts(txn)
        .await
        .context(h!())?
        .into_iter()
        .filter(|a| a.id.eq(&account_id))
        .next()
        .context(h!())?;

    let messenger = parse_message_source(&account).context(h!())?;
    let system_service_name = account.system_service_name.context(h!())?;
    let code = echo_im::link_account(&system_service_name, messenger, txn)
        .await
        .context(h!())?;

    Ok(code)
}

pub async fn list_accounts(
    txn: &DatabaseTransaction,
) -> anyhow::Result<Vec<EchoAccountF1>> {
    #[derive(FromQueryResult)]
    struct LinkedAccountRow {
        pub id: i64,
        pub aor_id: Option<i64>,
        pub kind: String,
        pub datasource_phone_number: Option<String>,
        pub display_name: String,
        pub description: Option<String>,
        pub status: AccountStatus,
        pub created_at: DateTime,
        pub client_id: Option<i32>,
        pub system_service_name: Option<String>,
        pub source: sea_orm_active_enums::EchoMessageSource,
        pub echo_phone_number: Option<String>,
        pub is_linked: Option<bool>,
        pub is_client_deleted: Option<bool>,
    }

    let datasource_recs = datasource::Entity::find()
        .join(
            JoinType::InnerJoin,
            datasource::Relation::EchoClientLock.def(),
        )
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::EchoClient.def(),
        )
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::EchoAccount.def(),
        )
        .select_only()
        .column(datasource::Column::Id)
        .column_as(datasource::Column::DefaultAorId, "aor_id")
        .column(datasource::Column::Kind)
        .column_as(datasource::Column::SignalPhone, "datasource_phone_number")
        .column(datasource::Column::DisplayName)
        .column(datasource::Column::Description)
        .column(datasource::Column::Status)
        .column(datasource::Column::CreatedAt)
        .column(echo_client_lock::Column::ClientId)
        .column_as(echo_client::Column::Name, "system_service_name")
        .column(echo_account::Column::Source)
        .column_as(echo_account::Column::PhoneNumber, "echo_phone_number")
        .column(echo_account::Column::IsLinked)
        .column_as(echo_client::Column::Deleted, "is_client_deleted")
        .into_model::<LinkedAccountRow>()
        .all(txn)
        .await
        .context(h!())?;

    let mut datasources = vec![];
    for a in datasource_recs {
        if a.is_client_deleted.unwrap_or(false) {
            continue;
        }
        let (phone_number, is_imported, messenger) = if a.client_id.is_some() {
            (
                a.echo_phone_number.context(h!())?,
                false,
                a.source.into_value().to_string(),
            )
        } else {
            (a.datasource_phone_number.context(h!())?, true, a.kind)
        };

        let area_of_responsibility = match a.aor_id {
            None => None,
            Some(id) => area_of_responsibility::Entity::find_by_id(id)
                .one(txn)
                .await
                .context(h!())?
                .map(render_aor),
        };

        datasources.push(EchoAccountF1 {
            id: a.id,
            area_of_responsibility,
            status: a.status.into_value().to_string(),
            created_at: a.created_at.and_utc().timestamp_millis(),
            client_id: a.client_id,
            display_name: a.display_name,
            system_service_name: a.system_service_name,
            messenger,
            phone_number,
            is_linked: a.is_linked.unwrap_or(false),
            description: a.description,
            is_imported,
        });
    }
    Ok(datasources)
}

pub async fn find_port_available(
    start: i32,
    end: i32,
) -> Result<i32, AppError> {
    let Some(port) = (start..end).find(|p| {
        match TcpListener::bind(format!("127.0.0.1:{}", p)) {
            Ok(_) => true,
            Err(_) => false,
        }
    }) else {
        return Err(AppError::BL {
            msg: "can't find free port".to_string(),
        });
    };
    Ok(port)
}

fn is_valid_service_name(s: &str) -> bool {
    if s.len() < 4 {
        return false; // too short
    }
    s.chars().all(|c| {
        c.is_ascii_lowercase() || // Lowercase Latin symbols (a-z)
            c.is_ascii_digit() ||    // Numbers (0-9)
            c == '-' ||              // Dash (-)
            c == '_' // Underscore (_)
    })
}

fn parse_message_source(
    account: &EchoAccountF1,
) -> anyhow::Result<MessageSource> {
    let messenger = account.messenger.to_lowercase();
    match messenger.as_str() {
        "signal" => Ok(MessageSource::Signal),
        "whatsapp" => Ok(MessageSource::Whatsapp),
        _ => bail!("Unknown message source: {messenger}"),
    }
}

pub async fn upsert_group_area_of_responsibility(
    txn: &DatabaseTransaction,
    master_key: &str,
    area_of_responsibility_id: Option<i64>,
) -> Result<Option<Model>, AppError> {
    Ok(match area_of_responsibility_id {
        None => {
            signal_group_aor::Entity::delete_many()
                .filter(signal_group_aor::Column::MasterKey.eq(master_key))
                .exec(txn)
                .await
                .context(h!())?;
            None
        }
        Some(id) => {
            let sg_aor = signal_group_aor::Entity::find()
                .filter(signal_group_aor::Column::MasterKey.eq(master_key))
                .one(txn)
                .await
                .context(h!())?;
            let has_old_sg_aor =
                sg_aor.clone().map(|x| !x.aor_id.eq(&id)).is_some();
            let has_ok_sg_aor =
                sg_aor.clone().map(|x| x.aor_id.eq(&id)).is_some();
            if has_old_sg_aor {
                sg_aor.context(h!())?.delete(txn).await.context(h!())?;
            }
            if !has_ok_sg_aor {
                signal_group_aor::ActiveModel {
                    master_key: Set(master_key.to_string()),
                    aor_id: Set(id),
                    id: NotSet,
                    created_at: NotSet,
                }
                .insert(txn)
                .await
                .context(h!())?;
            }
            area_of_responsibility::Entity::find_by_id(id)
                .one(txn)
                .await
                .context(h!())?
        }
    })
}
