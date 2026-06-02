use crate::messenger::{self, CreateMessengerReq, MessengerKind};
use crate::AppState;
use actix_web::{get, post, web, HttpResponse, Responder};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(list_messengers)
        .service(create_messenger)
        .service(link_messenger)
        .service(messenger_status)
        .service(whatsapp_qrcode)
        .service(whatsapp_health)
        .service(whatsapp_groups)
        .service(whatsapp_send)
        .service(signal_health)
        .service(signal_accounts)
        .service(signal_groups)
        .service(signal_send);
}

#[get("/ui-api/messengers")]
async fn list_messengers(
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    let messengers = messenger::list(&state.db).await.map_err(error)?;
    Ok(web::Json(messengers))
}

#[post("/ui-api/messengers")]
async fn create_messenger(
    state: web::Data<AppState>,
    req: web::Json<CreateMessengerReq>,
) -> actix_web::Result<impl Responder> {
    let messenger =
        messenger::create(&state.db, &state.config, req.into_inner())
            .await
            .map_err(error)?;
    Ok(web::Json(messenger))
}

#[post("/ui-api/messengers/{name}/link")]
async fn link_messenger(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> actix_web::Result<impl Responder> {
    let rsp = messenger::link(&state.db, &path.into_inner())
        .await
        .map_err(error)?;
    Ok(web::Json(rsp))
}

#[get("/ui-api/messengers/{name}/status")]
async fn messenger_status(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> actix_web::Result<impl Responder> {
    let name = path.into_inner();
    let messenger = messenger::load(&state.db, &name).await.map_err(error)?;
    let is_linked = messenger::is_linked(&state.db, &name, messenger.kind)
        .await
        .map_err(error)?;
    Ok(web::Json(json!({ "isLinked": is_linked })))
}

#[get("/api/{name}/api/whatsapp/qrcode")]
async fn whatsapp_qrcode(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> actix_web::Result<impl Responder> {
    let name = path.into_inner();
    let messenger =
        require_kind(&state, &name, MessengerKind::Whatsapp).await?;
    let user = if messenger.is_linked {
        messenger.phone
    } else {
        None
    };
    Ok(web::Json(json!({ "user": user })))
}

#[get("/api/{name}/api/whatsapp/health")]
async fn whatsapp_health(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> actix_web::Result<impl Responder> {
    let name = path.into_inner();
    let messenger =
        require_kind(&state, &name, MessengerKind::Whatsapp).await?;
    if messenger::is_linked(&state.db, &name, MessengerKind::Whatsapp)
        .await
        .map_err(error)?
    {
        Ok(web::Json(json!({ "client": messenger })))
    } else {
        Ok(web::Json(json!({ "error": "not linked" })))
    }
}

#[derive(Debug, Deserialize)]
struct GroupsQuery {
    refresh: Option<bool>,
    #[serde(rename = "includeChats")]
    include_chats: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WhatsappGroupRsp {
    id: String,
    name: String,
    is_group: bool,
}

#[get("/api/{name}/api/whatsapp/groups")]
async fn whatsapp_groups(
    state: web::Data<AppState>,
    path: web::Path<String>,
    query: web::Query<GroupsQuery>,
) -> actix_web::Result<impl Responder> {
    let name = path.into_inner();
    require_kind(&state, &name, MessengerKind::Whatsapp).await?;
    if query.refresh.unwrap_or(false) {
        messenger::refresh_groups(&state.db, &name, MessengerKind::Whatsapp)
            .await
            .map_err(error)?;
    }
    let groups = messenger::groups(&state.db, &name, MessengerKind::Whatsapp)
        .await
        .map_err(error)?
        .into_iter()
        .map(|group| WhatsappGroupRsp {
            id: group.id,
            name: group.name,
            is_group: true,
        })
        .collect::<Vec<_>>();
    let groups = if query.include_chats.unwrap_or(false) {
        let mut groups = groups;
        groups.extend(
            messenger::chats(&state.db, &name, MessengerKind::Whatsapp)
                .await
                .map_err(error)?
                .into_iter()
                .map(|chat| WhatsappGroupRsp {
                    id: chat.id,
                    name: chat.name,
                    is_group: false,
                }),
        );
        groups
    } else {
        groups
    };
    Ok(web::Json(groups))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WhatsappSendReq {
    group_id: String,
    message: String,
    screenshot: Option<String>,
}

#[post("/api/{name}/api/whatsapp/send")]
async fn whatsapp_send(
    state: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Json<WhatsappSendReq>,
) -> actix_web::Result<impl Responder> {
    let name = path.into_inner();
    require_kind(&state, &name, MessengerKind::Whatsapp).await?;
    let req = req.into_inner();
    let attachments = req.screenshot.into_iter().collect();
    messenger::send(
        &state.db,
        &name,
        MessengerKind::Whatsapp,
        vec![req.group_id],
        vec![],
        req.message,
        attachments,
    )
    .await
    .map_err(error)?;
    Ok(HttpResponse::Created().json(json!({ "ok": true })))
}

#[get("/api/{name}/api/signal/health")]
async fn signal_health(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> actix_web::Result<impl Responder> {
    let name = path.into_inner();
    require_kind(&state, &name, MessengerKind::Signal).await?;
    Ok(HttpResponse::Ok().finish())
}

#[get("/api/{name}/api/signal/accounts")]
async fn signal_accounts(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> actix_web::Result<impl Responder> {
    let name = path.into_inner();
    let messenger = require_kind(&state, &name, MessengerKind::Signal).await?;
    if messenger::is_linked(&state.db, &name, MessengerKind::Signal)
        .await
        .map_err(error)?
    {
        Ok(HttpResponse::Ok()
            .json(messenger.phone.into_iter().collect::<Vec<_>>()))
    } else {
        Ok(HttpResponse::Ok().json(Vec::<String>::new()))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalGroupRsp {
    ids: SignalGroupIds,
    name: String,
    is_group: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalGroupIds {
    internal_id: String,
    group_id: String,
}

#[get("/api/{name}/api/signal/groups/{phone}")]
async fn signal_groups(
    state: web::Data<AppState>,
    path: web::Path<(String, String)>,
    query: web::Query<GroupsQuery>,
) -> actix_web::Result<impl Responder> {
    let (name, _phone) = path.into_inner();
    require_kind(&state, &name, MessengerKind::Signal).await?;
    if query.refresh.unwrap_or(false) {
        messenger::refresh_groups(&state.db, &name, MessengerKind::Signal)
            .await
            .map_err(error)?;
    }
    let groups = messenger::groups(&state.db, &name, MessengerKind::Signal)
        .await
        .map_err(error)?
        .into_iter()
        .map(|group| SignalGroupRsp {
            ids: SignalGroupIds {
                internal_id: group
                    .internal_id
                    .unwrap_or_else(|| group.id.clone()),
                group_id: group.id,
            },
            name: group.name,
            is_group: true,
        })
        .collect::<Vec<_>>();
    Ok(web::Json(groups))
}

#[derive(Debug, Deserialize)]
struct SignalSendReq {
    recipients: Vec<String>,
    number: String,
    message: Option<String>,
    base64_attachments: Option<Vec<String>>,
}

struct SignalRecipientTargets {
    phones: Vec<String>,
    group_ids: Vec<String>,
}

#[post("/api/{name}/api/signal/send")]
async fn signal_send(
    state: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Json<SignalSendReq>,
) -> actix_web::Result<impl Responder> {
    let name = path.into_inner();
    require_kind(&state, &name, MessengerKind::Signal).await?;
    let req = req.into_inner();
    let known_group_ids =
        messenger::groups(&state.db, &name, MessengerKind::Signal)
            .await
            .map_err(error)?
            .into_iter()
            .map(|group| group.id)
            .collect::<HashSet<_>>();
    let targets = classify_signal_recipients(req.recipients, &known_group_ids);
    let _ = req.number;
    messenger::send(
        &state.db,
        &name,
        MessengerKind::Signal,
        targets.group_ids,
        targets.phones,
        req.message.unwrap_or_default(),
        req.base64_attachments.unwrap_or_default(),
    )
    .await
    .map_err(error)?;
    Ok(HttpResponse::Created().json(json!({ "ok": true })))
}

async fn require_kind(
    state: &web::Data<AppState>,
    name: &str,
    kind: MessengerKind,
) -> actix_web::Result<messenger::MessengerView> {
    let messenger = messenger::load(&state.db, name).await.map_err(error)?;
    if messenger.kind != kind {
        return Err(actix_web::error::ErrorNotFound(format!(
            "{name} is not a {} messenger",
            kind.as_str()
        )));
    }
    Ok(messenger)
}

fn error(err: anyhow::Error) -> actix_web::Error {
    actix_web::error::ErrorInternalServerError(err.to_string())
}

fn classify_signal_recipients(
    recipients: Vec<String>,
    known_group_ids: &HashSet<String>,
) -> SignalRecipientTargets {
    let mut targets = SignalRecipientTargets {
        phones: Vec::new(),
        group_ids: Vec::new(),
    };
    for recipient in recipients {
        if known_group_ids.contains(&recipient) {
            targets.group_ids.push(recipient);
        } else if is_signal_phone_recipient(&recipient) {
            targets.phones.push(recipient);
        } else {
            targets.group_ids.push(recipient);
        }
    }
    targets
}

fn is_signal_phone_recipient(recipient: &str) -> bool {
    let Some(digits) = recipient.strip_prefix('+') else {
        return false;
    };
    (7..=15).contains(&digits.len())
        && digits.chars().all(|ch| ch.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known_group_ids(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn classifies_e164_recipient_as_phone() {
        let targets = classify_signal_recipients(
            vec!["+380501234567".to_string()],
            &HashSet::new(),
        );

        assert_eq!(targets.phones, vec!["+380501234567"]);
        assert!(targets.group_ids.is_empty());
    }

    #[test]
    fn classifies_plus_prefixed_base64_like_recipient_as_group() {
        let targets = classify_signal_recipients(
            vec!["+AbCdEf/123==".to_string()],
            &HashSet::new(),
        );

        assert!(targets.phones.is_empty());
        assert_eq!(targets.group_ids, vec!["+AbCdEf/123=="]);
    }

    #[test]
    fn known_group_id_takes_priority_over_phone_shape() {
        let targets = classify_signal_recipients(
            vec!["+380501234567".to_string()],
            &known_group_ids(&["+380501234567"]),
        );

        assert!(targets.phones.is_empty());
        assert_eq!(targets.group_ids, vec!["+380501234567"]);
    }

    #[test]
    fn classifies_mixed_signal_recipients() {
        let targets = classify_signal_recipients(
            vec![
                "+380501234567".to_string(),
                "group.RGozSXow".to_string(),
                "+AbCdEf/123==".to_string(),
            ],
            &known_group_ids(&["group.RGozSXow"]),
        );

        assert_eq!(targets.phones, vec!["+380501234567"]);
        assert_eq!(targets.group_ids, vec!["group.RGozSXow", "+AbCdEf/123=="]);
    }
}
