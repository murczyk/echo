use super::{group_admin_data, signal_group};
use crate::config::*;
use crate::entities::area_of_responsibility::Model;
use crate::entities::sea_orm_active_enums::AccountStatus;
use crate::entities::*;
use crate::error::ContextAndError;
use crate::messenger::group::collect_group_stats;
use crate::messenger::types::{EchoAccountF1, GroupUpdateReq};
use crate::sigint::aor::{load_default_aor, render_aor};
use crate::types::AppError;
use crate::types::*;
use echo_im::entities::sea_orm_active_enums::{
    EchoMessageSource, SignalCliMode,
};
use echo_im::os_specific;
use echo_im::types::MessageSource;
use sea_orm::prelude::DateTime;
use sea_orm::prelude::*;
use sea_orm::{
    ConnectionTrait, DatabaseTransaction, FromQueryResult, IntoActiveModel,
    JoinType, NotSet, QuerySelect, Set, TransactionTrait,
};
use std::net::TcpListener;

pub async fn load_echo_account<'a, 'async_trait, C>(
    id: i64,
    txn: &'a C,
) -> Result<EchoAccountF1, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let account = list_accounts(Some(id), txn)
        .await
        .context(h!())?
        .into_iter()
        .find(|a| a.id == id)
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
    login: &String,
) -> Result<EchoAccountF1, AppError> {
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
    account.updated_by = Set(Some(login.to_string()));
    let result = account.update(txn).await.context(h!())?;
    let account = list_accounts(Some(result.id), txn)
        .await
        .context(h!())?
        .into_iter()
        .next()
        .context(h!())?;
    Ok(account)
}

pub async fn deactivate_account(
    id: i64,
    txn: &DatabaseTransaction,
    login: &String,
) -> Result<(), AppError> {
    let account = load_echo_account(id, txn).await.context(h!())?;
    let datasource = datasource::Entity::find_by_id(account.id)
        .one(txn)
        .await
        .context(h!())?
        .context(h!())?;
    if let Some(service_name) = account.system_service_name {
        if !datasource.deleted {
            let source =
                parse_message_source(&account.messenger).context(h!())?;
            echo_im::unlink_account(&service_name, source, txn)
                .await
                .context(h!())?;
        }
    }
    let mut datasource = datasource.into_active_model();
    datasource.deleted = Set(true);
    datasource.updated_by = Set(Some(login.to_string()));
    datasource.update(txn).await.context(h!())?;
    Ok(())
}

pub async fn link_account(
    datasource_id: Option<i64>,
    phone_number: &str,
    display_name: &str,
    system_service_name: &str,
    source: &str,
    description: Option<String>,
    aor_id: i64,
    txn: &DatabaseTransaction,
    login: &String,
) -> Result<EchoAccountF1, AppError> {
    if !is_valid_service_name(system_service_name) {
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
    let unit_name = format!("{src_name}@{system_service_name}");
    let accounts = list_accounts(None, txn).await.context(h!())?;
    let existing_account = accounts
        .into_iter()
        .filter(|a| {
            a.system_service_name
                .clone()
                .map(|s| s.eq(system_service_name))
                .is_some()
        })
        .filter(|a| a.phone_number.eq(phone_number))
        .find(|a| a.messenger.eq(&src_name));

    if let Some(acc) = existing_account {
        let msg = format!("Номером телефону {phone_number} вже прив'язано");
        error!("{msg}: {acc:?}");
        return Err(AppError::BL { msg });
    }

    let port = find_port_available(8010, 9000).await.context(h!())?;
    let src_display_name = src.to_string().to_lowercase();
    let attachment_path = format!(
        "/etc/echo/{src_display_name}-cli-data/{system_service_name}/{src_display_name}-cli/attachments/"
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
            msg: format!("{res:?}"),
        }
    })
    .cae(h!())?;

    let lock = echo_im::set_account_phone(
        String::from(phone_number),
        system_service_name,
        src.clone(),
        true,
        txn,
    )
    .await
    .cae(h!())?;

    let id = if let Some(id) = datasource_id {
        let datasource = datasource::Entity::find_by_id(id)
            .one(txn)
            .await
            .context(h!())?
            .context(h!())?;
        let mut datasource = datasource.into_active_model();
        datasource.echo_client_lock_id = Set(Some(lock.id as i64));
        datasource.update(txn).await.context(h!())?.id
    } else {
        datasource::ActiveModel {
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
            api_login: NotSet,
            updated_by: Set(Some(login.to_string())),
            deleted: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?
        .id
    };

    match src {
        MessageSource::Signal => os_specific::start_new_signal_client(
            system_service_name,
            port,
            SIGNAL_CLIENT_DIR,
            SIGNAL_UNIT_NAME,
            CLIENT_DATA_DIR_NAME,
            &SignalCliMode::Native,
        )
        .await
        .context(h!())?,
        MessageSource::Whatsapp => os_specific::start_new_whatsapp_client(
            system_service_name,
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
    db: &DatabaseConnection,
    login: &String,
) -> Result<String, AppError> {
    let m_account = list_accounts(Some(account_id), db)
        .await
        .context(h!())?
        .into_iter()
        .filter(|a| a.system_service_name.is_some())
        .find(|a| a.id.eq(&account_id));

    let account = match m_account {
        Some(account) => account,
        None => {
            debug!("creating new account for datasource {account_id}");
            let txn = db.begin().await.context(h!())?;
            let result = link_existing_datasource(account_id, &txn, login)
                .await
                .context(h!())?;
            txn.commit().await.context(h!())?;
            result
        }
    };

    let messenger = parse_message_source(&account.messenger).context(h!())?;
    let system_service_name = account.system_service_name.context(h!())?;

    let txn = db.begin().await.context(h!())?;
    let code = echo_im::link_account(&system_service_name, messenger, &txn)
        .await
        .context(h!())?;
    let m_login = Some(login.to_string());
    datasource::Entity::update_many()
        .filter(datasource::Column::Id.eq(account.id))
        .col_expr(datasource::Column::UpdatedBy, Expr::value(m_login))
        .exec(&txn)
        .await
        .context(h!())?;
    txn.commit().await.context(h!())?;

    Ok(code)
}

async fn link_existing_datasource(
    datasource_id: i64,
    txn: &DatabaseTransaction,
    login: &String,
) -> anyhow::Result<EchoAccountF1> {
    let datasource = datasource::Entity::find_by_id(datasource_id)
        .one(txn)
        .await
        .context(h!())?
        .context(h!())?;
    let phone_number = datasource.signal_phone.context(h!())?;
    let process_name =
        transliterate_and_slugify(&datasource.display_name.to_lowercase());
    let aor_id = match datasource.default_aor_id {
        Some(id) => id,
        None => load_default_aor(txn).await.context(h!())?.id,
    };
    link_account(
        Some(datasource_id),
        &phone_number,
        &datasource.display_name,
        &process_name,
        &datasource.kind,
        datasource.description,
        aor_id,
        txn,
        login,
    )
    .await
    .context(h!())
}

pub async fn list_accounts<'a, 'async_trait, C>(
    m_id: Option<i64>,
    txn: &'a C,
) -> Result<Vec<EchoAccountF1>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
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
        pub source: Option<sea_orm_active_enums::EchoMessageSource>,
        pub echo_phone_number: Option<String>,
        pub is_linked: Option<bool>,
        pub is_client_deleted: Option<bool>,
    }

    let mut q = datasource::Entity::find();
    if let Some(id) = m_id {
        q = q.filter(datasource::Column::Id.eq(id));
    }
    let datasource_recs = q
        .join(
            JoinType::LeftJoin,
            datasource::Relation::EchoClientLock.def(),
        )
        .join(
            JoinType::LeftJoin,
            echo_client_lock::Relation::EchoClient.def(),
        )
        .join(
            JoinType::LeftJoin,
            echo_client_lock::Relation::EchoAccount.def(),
        )
        .filter(datasource::Column::Deleted.eq(false))
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
                a.source.context(h!())?.into_value().to_string(),
            )
        } else {
            let Some(phone) = a.datasource_phone_number else {
                warn!(
                    "no phone number for datasource {}, skipping, at {}",
                    a.id,
                    h!()
                );
                continue;
            };
            (phone, true, a.kind)
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
    let Some(port) = (start..end)
        .find(|p| TcpListener::bind(format!("127.0.0.1:{p}")).is_ok())
    else {
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

fn parse_message_source(messenger: &str) -> anyhow::Result<MessageSource> {
    let messenger = messenger.to_lowercase();
    match messenger.as_str() {
        "signal" => Ok(MessageSource::Signal),
        "whatsapp" => Ok(MessageSource::Whatsapp),
        _ => bail!("Unknown message source: {messenger}"),
    }
}

pub async fn upsert_group_area_of_responsibility(
    txn: &DatabaseTransaction,
    master_key: &str,
    aor_ids: Option<Vec<i64>>,
) -> Result<Vec<Model>, AppError> {
    let res = match aor_ids {
        None => {
            signal_group_aor::Entity::delete_many()
                .filter(signal_group_aor::Column::MasterKey.eq(master_key))
                .exec(txn)
                .await
                .context(h!())?;
            vec![]
        }
        Some(aor_ids) => {
            // Delete existing associations for this master_key
            signal_group_aor::Entity::delete_many()
                .filter(signal_group_aor::Column::MasterKey.eq(master_key))
                .exec(txn)
                .await
                .context(h!())?;

            // Insert new associations
            for aor_id in &aor_ids {
                signal_group_aor::ActiveModel {
                    master_key: Set(master_key.to_string()),
                    aor_id: Set(*aor_id),
                    id: NotSet,
                    created_at: NotSet,
                }
                .insert(txn)
                .await
                .context(h!())?;
            }

            // Return all AOR models
            let mut models = vec![];
            for aor_id in &aor_ids {
                if let Some(model) =
                    area_of_responsibility::Entity::find_by_id(*aor_id)
                        .one(txn)
                        .await
                        .context(h!())?
                {
                    models.push(model);
                }
            }
            models
        }
    };
    Ok(res)
}

pub struct BlGroupUpdateRes {
    pub group: signal_group::Model,
    pub group_data: group_admin_data::Model,
    pub stats: crate::rer_importer::types::SignalGroupStats,
    pub aors: Vec<Model>,
}

pub async fn bl_group_update(
    req: &GroupUpdateReq,
    txn: &DatabaseTransaction,
) -> Result<BlGroupUpdateRes, AppError> {
    let m_group = group_admin_data::Entity::find()
        .filter(
            group_admin_data::Column::GroupMasterKey.eq(req.master_key.clone()),
        )
        .one(txn)
        .await
        .context(h!())?;
    let mut group_data = match m_group {
        Some(group) => group,
        None => group_admin_data::ActiveModel {
            group_master_key: Set(Some(req.master_key.clone())),
            short_note: Set(req.short_note.clone()),
            long_note: Set(req.long_note.clone()),
            id: NotSet,
            created_at: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?,
    }
    .into_active_model();

    let aor_ids = match &req.area_of_responsibility_ids {
        None => req.area_of_responsibility_id.map(|id| vec![id]),
        Some(ids) => Some(ids.clone()),
    };
    let aors =
        upsert_group_area_of_responsibility(txn, &req.master_key, aor_ids)
            .await
            .context(h!())?;

    group_data.short_note = Set(req.short_note.clone());
    group_data.long_note = Set(req.long_note.clone());
    let group_data = group_data.update(txn).await.context(h!())?;

    let group = signal_group::Entity::find_by_id(req.master_key.clone())
        .one(txn)
        .await
        .context(h!())?
        .context(h!())?;

    let stats = collect_group_stats(vec![group.master_key.clone()], txn)
        .await
        .context(h!())?
        .get(&group.master_key)
        .cloned()
        .unwrap_or_default();

    Ok(BlGroupUpdateRes {
        group,
        group_data,
        stats,
        aors,
    })
}

// Transliterates a Cyrillic character to its Latin equivalent.
fn cyrillic_to_latin(c: char) -> Option<&'static str> {
    match c {
        'а' => Some("a"),
        'б' => Some("b"),
        'в' => Some("v"),
        'г' => Some("h"),
        'ґ' => Some("g"),
        'д' => Some("d"),
        'е' => Some("e"),
        'ж' => Some("zh"),
        'з' => Some("z"),
        'и' => Some("y"),
        'і' => Some("i"),
        'ї' => Some("yi"),
        'й' => Some("y"),
        'к' => Some("k"),
        'л' => Some("l"),
        'м' => Some("m"),
        'н' => Some("n"),
        'о' => Some("o"),
        'п' => Some("p"),
        'р' => Some("r"),
        'с' => Some("s"),
        'т' => Some("t"),
        'у' => Some("u"),
        'ф' => Some("f"),
        'х' => Some("kh"),
        'ц' => Some("ts"),
        'ч' => Some("ch"),
        'ш' => Some("sh"),
        'щ' => Some("shch"),
        'ь' => Some(""),
        'є' => Some("ye"),
        'ю' => Some("yu"),
        'я' => Some("ya"),
        _ => None,
    }
}

// Transliterates a given string, handling Cyrillic characters and non-alphabetic symbols.
pub fn transliterate_and_slugify(input: &str) -> String {
    let mut result = String::new();
    let mut last_char_was_space = false;

    for c in input.chars() {
        if let Some(latin_char) = cyrillic_to_latin(c) {
            result.push_str(latin_char);
            last_char_was_space = false;
        } else if c.is_ascii_alphabetic() {
            result.push(c);
            last_char_was_space = false;
        } else if !last_char_was_space {
            result.push(' ');
            last_char_was_space = true;
        }
    }

    // Clean up spaces and replace with dashes
    result.trim().replace(' ', "-")
}
