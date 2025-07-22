pub use super::utils::*;
use crate::config::*;
use crate::entities::*;
use crate::error::ContextAndError;
use crate::types::AppError;
use crate::types::*;
use crate::utils::*;
use echo_im::entities::sea_orm_active_enums::{
    EchoMessageSource, SignalCliMode,
};
use echo_im::os_specific;
use echo_im::types::*;
use sea_orm::*;

pub struct Link {
    pub id: i32,
    pub user_id: i32,
    pub group_id: i32,
    pub organism_id: i32,
    pub group_name: String,
    pub organism_name: String,
}

pub async fn create_bot(
    phone_number: &str,
    display_name: &str,
    source: EchoMessageSource,
    txn: &DatabaseTransaction,
) -> Result<messenger_bot::Model, AppError> {
    let existing_bot = messenger_bot::Entity::find()
        .filter(messenger_bot::Column::Messenger.eq(source.clone()))
        .filter(messenger_bot::Column::PhoneNumber.eq(phone_number))
        .filter(messenger_bot::Column::Deleted.eq(false))
        .limit(1)
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .next();

    if let Some(bot) = existing_bot {
        let err_msg = format!(
            "Бот з номером телефону {} вже існує: {:?}",
            phone_number, bot
        );
        error!("{}", err_msg);
        return Err(AppError::BL(err_msg));
    }

    let port = find_port_available(8010, 9000).await.context(h!())?;
    let src_name = source.to_string().to_lowercase();
    let attachment_path = format!(
        "/etc/oblik-os/{}-bot/{}/{}-cli/attachments/",
        src_name, display_name, src_name
    );
    let unit_name = match &source {
        EchoMessageSource::Signal => {
            format!("{}@{}", SIGNAL_BOT_UNIT_NAME, display_name)
        }
        EchoMessageSource::Whatsapp => {
            format!("{}@{}", WHATSAPP_BOT_UNIT_NAME, display_name)
        }
    };
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
            AppError::BL(format!("{:?}", res))
        })
        .cae(h!())?;

    let new_bot = messenger_bot::ActiveModel {
        id: NotSet,
        name: Set(display_name.to_string()),
        display_name: Set(display_name.to_string()),
        phone_number: Set(Some(phone_number.to_string())),
        messenger: Set(source.clone()),
        status: Set(BotStatus::Ready),
        created_at: NotSet,
        deleted: Set(false),
    }
        .insert(txn)
        .await
        .context(h!())?;

    let source = map_source(&new_bot.messenger);

    let new_bot = new_bot
        .into_active_model()
        .update(txn)
        .await
        .context(h!())?;

    echo_im::set_account_phone(
        String::from(phone_number),
        &new_bot.name,
        source.clone(),
        true,
        txn,
    )
        .await
        .cae(h!())?;

    match source {
        MessageSource::Signal => os_specific::start_new_signal_client(
            &new_bot.name,
            port,
            SIGNAL_CLIENT_BOT_DIR,
            SIGNAL_BOT_UNIT_NAME,
            BOT_DATA_DIR_NAME,
            &SignalCliMode::Native,
        )
            .await
            .context(h!())?,
        MessageSource::Whatsapp => os_specific::start_new_whatsapp_client(
            &new_bot.name,
            WHATSAPP_CLIENT_CONFIG,
            WHATSAPP_CLIENT_BOT_DIR,
            WHATSAPP_BOT_UNIT_NAME,
            BOT_DATA_DIR_NAME,
        )
            .await
            .context(h!())?,
    };

    Ok(new_bot)
}

pub async fn link_bot_organism(
    bot_id: i32,
    organism_id: i32,
    group_id: i32,
    user_id: i32,
    txn: &DatabaseTransaction,
) -> Result<i32, AppError> {
    if load_bot_by_id(bot_id, txn).await.context(h!())?.is_none() {
        return Err(AppError::NotFoundEx(bot_id.to_string()));
    }

    let link_id = bot_organism_link::ActiveModel {
        id: NotSet,
        bot_id: Set(bot_id),
        organism_id: Set(organism_id),
        group_id: Set(group_id),
        user_id: Set(user_id),
        created_at: NotSet,
    }
        .insert(txn)
        .await
        .context(h!())
        .map_err(|x| AppError::BL(x.to_string()))?
        .id;

    Ok(link_id)
}

pub async fn unlink_bot_organism(
    link_id: i32,
    txn: &DatabaseTransaction,
) -> Result<bool, AppError> {
    let result = bot_organism_link::Entity::delete_by_id(link_id)
        .exec(txn)
        .await
        .cae(h!())?;
    Ok(result.rows_affected > 0)
}

pub async fn get_bot_qr_code(
    messenger: EchoMessageSource,
    txn: &DatabaseTransaction,
) -> Result<String, AppError> {
    let bot = load_bot_by_id(id, txn).await
        .cae(h!())?;

    let Some(bot) = bot else {
        return Err(AppError::NotFound);
    };

    let messenger = map_source(&bot.messenger);
    let client_id = bot.name.clone();

    let code =
        echo_im::link_account(&client_id, messenger.clone(), txn, &bot.name)
            .await
            .cae(h!())?;

    Ok(code)
}

fn map_source(source: &EchoMessageSource) -> MessageSource {
    match &source {
        EchoMessageSource::Signal => MessageSource::Signal,
        EchoMessageSource::Whatsapp => MessageSource::Whatsapp,
    }
}

pub async fn destroy_bot(
    id: i32,
    txn: &DatabaseTransaction,
) -> Result<(), AppError> {
    let bot = load_bot_by_id(id, txn).await
        .cae(h!())?;

    let Some(bot) = bot else {
        return Err(AppError::BL("nothing to destroy".to_string()));
    };
    echo_im::detach_client(&bot.name, txn).await.context(h!())?;

    let bot_name = bot.name.clone();
    let source = bot.messenger.clone();

    let mut bot = bot.into_active_model();
    bot.deleted = Set(true);
    bot.update(txn).await.context(h!())?;

    match source {
        EchoMessageSource::Signal => os_specific::stop_signal_client(
            &bot_name,
            SIGNAL_CLIENT_BOT_DIR,
            SIGNAL_BOT_UNIT_NAME,
        )
            .await
            .context(h!())?,
        EchoMessageSource::Whatsapp => os_specific::stop_whatsapp_client(
            &bot_name,
            WHATSAPP_CLIENT_BOT_DIR,
            WHATSAPP_BOT_UNIT_NAME,
        )
            .await
            .context(h!())?,
    };
    Ok(())
}

pub async fn list_links(
    bot_id: i32,
    txn: &DatabaseTransaction,
) -> Result<Vec<Link>, AppError> {
    if load_bot_by_id(bot_id, txn).await.context(h!())?.is_none() {
        return Err(AppError::NotFoundEx(bot_id.to_string()));
    }

    let links = bot_organism_link::Entity::find()
        .filter(bot_organism_link::Column::BotId.eq(bot_id))
        .all(txn)
        .await
        .map_err(|x| AppError::BL(x.to_string()))?;
    if links.is_empty() {
        return Ok(vec![]);
    }
    let organism_ids = links
        .iter()
        .map(|link| link.organism_id)
        .collect::<Vec<_>>();
    let group_ids = links.iter().map(|link| link.group_id).collect::<Vec<_>>();
    let organism_names = battle_unit::Entity::find()
        .filter(battle_unit::Column::Id.is_in(organism_ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|x| (x.id, x.name))
        .collect::<BTreeMap<_, _>>();
    let group_names = messenger_group::Entity::find()
        .filter(messenger_group::Column::Id.is_in(group_ids))
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .map(|x| (x.id, x.name))
        .collect::<BTreeMap<_, _>>();

    let mut result = vec![];
    for l in links {
        result.push(Link {
            group_name: group_names.get(&l.group_id).context(h!())?.clone(),
            organism_name: organism_names
                .get(&l.organism_id)
                .context(h!())?
                .clone(),
            id: l.id,
            user_id: l.user_id,
            group_id: l.group_id,
            organism_id: l.organism_id,
        });
    }
    Ok(result)
}

pub async fn update_bot(
    id: i32,
    is_active: Option<bool>,
    display_name: Option<String>,
    txn: &DatabaseTransaction,
) -> Result<messenger_bot::Model, AppError> {
    let bot = load_bot_by_id(id, txn).await
        .cae(h!())?;

    let Some(bot) = bot else {
        return Err(AppError::NotFoundEx(id.to_string()));
    };

    let mut bot = bot.into_active_model();

    if let Some(display_name) = display_name {
        bot.display_name = Set(display_name);
    }

    if let Some(is_active) = is_active {
        let new_status = match is_active {
            true => BotStatus::Active,
            false => BotStatus::Paused,
        };
        bot.status = Set(new_status);
    }
    bot.update(txn).await.cae(h!())
}

pub async fn get_bot_groups(
    id: &str,
    txn: &DatabaseTransaction,
) -> Result<Vec<messenger_group::Model>, AppError> {
    let bot_name = messenger_bot::Entity::find()
        .filter(messenger_bot::Column::Id.eq(parse_uuid(id).context(h!())?))
        .filter(messenger_bot::Column::Deleted.eq(false))
        .one(txn)
        .await
        .cae(h!())?;
    .context(h!())?
        .name;

    let internal_ids: Vec<String> = echo_im::list_groups(&bot_name, txn)
        .await
        .context(h!())?
        .iter()
        .filter(|x| !x.name.is_empty() && !x.deleted_by_messenger)
        .map(|x| x.id.clone())
        .collect();

    let groups = messenger_group::Entity::find()
        .filter(messenger_group::Column::ExternalId.is_in(internal_ids))
        .all(txn)
        .await
        .context(h!())?;

    Ok(groups)
}

pub async fn is_bot_linked(
    id: EchoMessageSource,
    txn: &DatabaseTransaction,
) -> Result<bool, AppError> {
    let Some(bot) = load_bot_by_id(id, txn).await.context(h!())? else {
        return Err(AppError::NotFoundEx(id.to_string()));
    };
    let is_linked = echo_im::is_client_logged_in(
        bot.name.as_str(),
        map_source(&bot.messenger),
        txn,
    )
        .await
        .context(h!())?;
    Ok(is_linked)
}

pub async fn deactivete_bot(
    source: EchoMessageSource,
    bot_name: &String,
) -> Result<(), AppError> {
    match source {
        EchoMessageSource::Signal => os_specific::stop_signal_client(
            &bot_name,
            SIGNAL_CLIENT_BOT_DIR,
            SIGNAL_BOT_UNIT_NAME,
        )
            .await
            .context(h!())?,
        EchoMessageSource::Whatsapp => os_specific::stop_whatsapp_client(
            &bot_name,
            WHATSAPP_CLIENT_BOT_DIR,
            WHATSAPP_BOT_UNIT_NAME,
        )
            .await
            .context(h!())?,
    };
    Ok(())
}

pub async fn react_to_message(
    message: &MessageF1,
    client: &str,
    is_ok: bool,
    has_warnings: bool,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let reaction_code = match is_ok {
        true => match has_warnings {
            true => "🥴",
            false => "🤖",
        },
        false => "❌",
    }
        .to_string();
    let req = ReactToMessageReq {
        message_internal_id: message.internal_id,
        reaction_code,
    };
    echo_im::react_to_inbox_message(req, client, txn)
        .await
        .context(h!())?;
    Ok(())
}

pub async fn edit_outbox_message(
    txn: &DatabaseTransaction,
    receipt: &str,
    new_text: &str,
    group_id: Option<String>, // group's external id
    bot_id: i32,
) -> Result<(), AppError> {
    let Some(bot) = load_bot_by_id(bot_id, txn).await.context(h!())? else {
        return Err(AppError::NotFoundEx(bot_id.to_string()));
    };
    if let Err(e) = echo_im::edit_outbox_message(
        EditMessageReq {
            outbox_message_receipt: receipt.to_string(),
            new_text: Some(new_text.to_string()),
            receiver: None,
            group: group_id,
            attachments: vec![],
        },
        &bot.name,
        &txn,
    )
        .await
    {
        error!("failed to update msg: {:?}", e);
    }
    Ok(())
}

pub async fn save_bot_inbox_message(
    txn: &DatabaseTransaction,
    message: &MessageF1,
    bot_id: i32,
    flight_message_id: Option<i32>,
    message_type: BotMessageType,
) -> Result<inbox_message::Model, AppError> {
    debug!(
        "save_bot_inbox_message; bot_id={}, flight_message_id={:?}",
        bot_id, flight_message_id
    );
    let group_id = messenger_group::Entity::find()
        .filter(
            messenger_group::Column::ExternalId.eq(message.group_id.clone()),
        )
        .one(txn)
        .await
        .context(h!())?
        .context(h!())?
        .id;
    Ok(inbox_message::ActiveModel {
        id: NotSet,
        group_id: Set(group_id),
        bot_id: Set(bot_id.clone()),
        message_timestamp: Set(message.timestamp),
        inbox_message_id: Set(message.internal_id.to_string()),
        message_type: Set(message_type),
        created_at: NotSet,
        flight_message_id: Set(flight_message_id),
    }
           .insert(txn)
           .await
           .cae(h!())?;)
}
