use crate::config::*;
use crate::entities::sea_orm_active_enums::AccountStatus;
use crate::entities::*;
use crate::error::ContextAndError;
use crate::messenger::types::EchoAccountF1;
use crate::types::AppError;
use crate::types::*;
use echo_im::entities::sea_orm_active_enums::{
    EchoMessageSource, SignalCliMode,
};
use echo_im::os_specific;
use echo_im::types::MessageSource;
use echo_migration::Expr;
use sea_orm::prelude::DateTime;
use sea_orm::*;
use std::net::TcpListener;

pub async fn load_echo_account(
    id: i64,
    txn: &DatabaseTransaction,
) -> Result<EchoAccountF1, AppError> {
    let account = list_linked_accounts(txn)
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
    set_active: bool,
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
    messenger_account::Entity::update_many()
        .filter(messenger_account::Column::Id.eq(id))
        .col_expr(messenger_account::Column::Status, Expr::value(new_status))
        .exec(txn)
        .await
        .context(h!())?;
    Ok(())
}

pub async fn deactivate_account(
    id: i64,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let account = load_echo_account(id, txn).await.context(h!())?;
    let messenger =
        EchoMessageSource::try_from_value(&account.messenger).context(h!())?;
    match messenger {
        EchoMessageSource::Signal => os_specific::stop_signal_client(
            &account.name,
            SIGNAL_CLIENT_DIR,
            SIGNAL_UNIT_NAME,
        )
        .await
        .context(h!())?,
        EchoMessageSource::Whatsapp => os_specific::stop_whatsapp_client(
            &account.name,
            WHATSAPP_CLIENT_DIR,
            WHATSAPP_UNIT_NAME,
        )
        .await
        .context(h!())?,
    };
    Ok(())
}

pub async fn link_account(
    phone_number: &str,
    display_name: &str,
    source: String,
    txn: &DatabaseTransaction,
) -> Result<EchoAccountF1, AppError> {
    if !is_valid_display_name(&display_name) {
        return Err(AppError::BL {
            msg: format!("Invalid display name: {display_name}"),
        });
    }
    let source = EchoMessageSource::try_from_value(&source).context(h!())?;

    let (src, src_name) = match &source {
        EchoMessageSource::Whatsapp => (echo_im::types::MessageSource::Whatsapp, SIGNAL_UNIT_NAME),
        EchoMessageSource::Signal => (echo_im::types::MessageSource::Signal, WHATSAPP_UNIT_NAME),
    };
    let unit_name = format!("{src_name}@{display_name}");
    let accounts = list_linked_accounts(txn).await.context(h!())?;
    let existing_account = accounts
        .into_iter()
        .filter(|a| a.name.eq(display_name))
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
    let attachment_path = format!(
        "/etc/oblik-os/{}-bot/{}/{}-cli/attachments/",
        src_name, display_name, src_name
    );
    echo_im::attach_new_client(
        display_name,
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
        &display_name,
        src.clone(),
        true,
        txn,
    )
    .await
    .cae(h!())?;

    let id = messenger_account::ActiveModel {
        echo_client_lock_id: Set(Some(lock.id as i64)),
        id: NotSet,
        status: NotSet,
        created_at: NotSet,
    }
    .insert(txn)
    .await
    .context(h!())?
    .id;

    match src {
        echo_im::types::MessageSource::Signal => {
            os_specific::start_new_signal_client(
                &display_name,
                port,
                SIGNAL_CLIENT_DIR,
                SIGNAL_UNIT_NAME,
                CLIENT_DATA_DIR_NAME,
                &SignalCliMode::Native,
            )
            .await
            .context(h!())?
        }
        echo_im::types::MessageSource::Whatsapp => {
            os_specific::start_new_whatsapp_client(
                &display_name,
                WHATSAPP_CLIENT_CONFIG,
                WHATSAPP_CLIENT_DIR,
                WHATSAPP_UNIT_NAME,
                CLIENT_DATA_DIR_NAME,
            )
            .await
            .context(h!())?
        }
    };

    load_echo_account(id, txn).await
}

pub async fn get_qr_code(
    account_id: i64,
    txn: &DatabaseTransaction,
) -> Result<String, AppError> {
    let account = list_linked_accounts(txn)
        .await
        .context(h!())?
        .into_iter()
        .filter(|a| a.id.eq(&account_id))
        .next()
        .context(h!())?;

    let messenger = parse_message_source(&account).context(h!())?;

    let code = echo_im::link_account(&account.name, messenger, txn)
        .await
        .context(h!())?;

    Ok(code)
}

pub async fn list_linked_accounts(
    txn: &DatabaseTransaction,
) -> anyhow::Result<Vec<EchoAccountF1>> {
    #[derive(FromQueryResult)]
    struct LinkedAccountRow {
        pub id: i64,
        pub status: AccountStatus,
        pub created_at: DateTime,
        pub client_id: i32,
        pub name: String,
        pub source: sea_orm_active_enums::EchoMessageSource,
        pub phone_number: String,
        pub is_linked: bool,
    }

    let messenger_accounts = messenger_account::Entity::find()
        .join(
            JoinType::InnerJoin,
            messenger_account::Relation::EchoClientLock.def(),
        )
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::EchoClient.def(),
        )
        .join(
            JoinType::InnerJoin,
            echo_client_lock::Relation::EchoAccount.def(),
        )
        .filter(echo_client::Column::Deleted.eq(false))
        .select_only()
        .column(messenger_account::Column::Id)
        .column(messenger_account::Column::Status)
        .column(messenger_account::Column::CreatedAt)
        .column(echo_client_lock::Column::ClientId)
        .column(echo_client::Column::Name)
        .column(echo_account::Column::Source)
        .column(echo_account::Column::PhoneNumber)
        .column(echo_account::Column::IsLinked)
        .into_model::<LinkedAccountRow>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|a| EchoAccountF1 {
            id: a.id,
            status: a.status.into_value().to_string(),
            created_at: a.created_at.and_utc().timestamp_millis(),
            client_id: a.client_id,
            name: a.name,
            messenger: a.source.into_value().to_string(),
            phone_number: a.phone_number,
            is_linked: a.is_linked,
        })
        .collect();
    Ok(messenger_accounts)
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

fn is_valid_display_name(s: &str) -> bool {
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
