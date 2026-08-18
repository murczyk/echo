use crate::automation::{
    self, PauseAutomationReq, SaveAutomationReq, SavePolygonReq,
};
use crate::error::{
    bad_request, not_found, ShortContext, UserError, UserErrorKind,
};
use crate::h;
use crate::messenger::{
    self, CreateMessengerReq, MessengerKind, UpdateMessengerReq,
};
use crate::AppState;
use actix_web::{
    delete, get, http::StatusCode, post, put, web, HttpResponse, Responder,
};
use base64::{engine::general_purpose, Engine};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashSet;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(list_messengers)
        .service(create_messenger)
        .service(update_messenger)
        .service(messenger_automation_impact)
        .service(link_messenger)
        .service(unlink_messenger)
        .service(messenger_status)
        .service(pause_messenger)
        .service(global_pause_status)
        .service(set_global_pause)
        .service(delete_messenger)
        .service(whatsapp_qrcode)
        .service(whatsapp_health)
        .service(whatsapp_groups)
        .service(whatsapp_send)
        .service(signal_health)
        .service(signal_accounts)
        .service(signal_groups)
        .service(signal_send)
        .service(automation_accounts)
        .service(automation_groups)
        .service(list_polygons)
        .service(create_polygon)
        .service(update_polygon)
        .service(delete_polygon)
        .service(list_automations)
        .service(create_automation)
        .service(update_automation)
        .service(pause_automation)
        .service(delete_automation);
}

#[get("/ui-api/messengers/{name}/automation-impact")]
async fn messenger_automation_impact(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> actix_web::Result<impl Responder> {
    let impact = messenger::automation_impact(&state.db, &path.into_inner())
        .await
        .c(h!())
        .map_err(error)?;
    Ok(web::Json(impact))
}

#[get("/ui-api/messengers")]
async fn list_messengers(
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    let messengers = messenger::list(&state.db).await.c(h!()).map_err(error)?;
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
            .c(h!())
            .map_err(error)?;
    Ok(web::Json(messenger))
}

#[put("/ui-api/messengers/{name}")]
async fn update_messenger(
    state: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Json<UpdateMessengerReq>,
) -> actix_web::Result<impl Responder> {
    let messenger = messenger::update(
        &state.db,
        &state.config,
        &path.into_inner(),
        req.into_inner(),
    )
    .await
    .c(h!())
    .map_err(error)?;
    Ok(web::Json(messenger))
}

#[post("/ui-api/messengers/{name}/link")]
async fn link_messenger(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> actix_web::Result<impl Responder> {
    let rsp = messenger::link(&state.db, &state.config, &path.into_inner())
        .await
        .c(h!())
        .map_err(error)?;
    Ok(web::Json(rsp))
}

#[post("/ui-api/messengers/{name}/unlink")]
async fn unlink_messenger(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> actix_web::Result<impl Responder> {
    messenger::unlink(&state.db, &path.into_inner())
        .await
        .c(h!())
        .map_err(error)?;
    Ok(HttpResponse::Ok().json(json!({ "ok": true })))
}

#[get("/ui-api/messengers/{name}/status")]
async fn messenger_status(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> actix_web::Result<impl Responder> {
    let name = path.into_inner();
    let messenger = messenger::load(&state.db, &name)
        .await
        .c(h!())
        .map_err(error)?;
    let is_linked = messenger::is_linked(&state.db, &name, messenger.kind)
        .await
        .c(h!())
        .map_err(error)?;
    Ok(web::Json(json!({ "isLinked": is_linked })))
}

#[delete("/ui-api/messengers/{name}")]
async fn delete_messenger(
    state: web::Data<AppState>,
    path: web::Path<String>,
) -> actix_web::Result<impl Responder> {
    messenger::delete(&state.db, &state.config, &path.into_inner())
        .await
        .c(h!())
        .map_err(error)?;
    Ok(HttpResponse::Ok().json(json!({ "ok": true })))
}

#[get("/ui-api/automation-accounts")]
async fn automation_accounts(
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    let accounts = automation::account_options(&state.db)
        .await
        .c(h!())
        .map_err(error)?;
    Ok(web::Json(accounts))
}

#[get("/ui-api/automation-groups")]
async fn automation_groups(
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    let groups = automation::group_options(&state.db)
        .await
        .c(h!())
        .map_err(error)?;
    Ok(web::Json(groups))
}

#[get("/ui-api/polygons")]
async fn list_polygons(
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    let polygons = automation::list_polygons(&state.db)
        .await
        .c(h!())
        .map_err(error)?;
    Ok(web::Json(polygons))
}

#[post("/ui-api/polygons")]
async fn create_polygon(
    state: web::Data<AppState>,
    req: web::Json<SavePolygonReq>,
) -> actix_web::Result<impl Responder> {
    let polygon = automation::create_polygon(&state.db, req.into_inner())
        .await
        .c(h!())
        .map_err(error)?;
    Ok(web::Json(polygon))
}

#[put("/ui-api/polygons/{id}")]
async fn update_polygon(
    state: web::Data<AppState>,
    path: web::Path<i64>,
    req: web::Json<SavePolygonReq>,
) -> actix_web::Result<impl Responder> {
    let polygon = automation::update_polygon(
        &state.db,
        path.into_inner(),
        req.into_inner(),
    )
    .await
    .c(h!())
    .map_err(error)?;
    Ok(web::Json(polygon))
}

#[delete("/ui-api/polygons/{id}")]
async fn delete_polygon(
    state: web::Data<AppState>,
    path: web::Path<i64>,
) -> actix_web::Result<impl Responder> {
    automation::delete_polygon(&state.db, path.into_inner())
        .await
        .c(h!())
        .map_err(error)?;
    Ok(HttpResponse::Ok().json(json!({ "ok": true })))
}

#[get("/ui-api/automations")]
async fn list_automations(
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    let automations =
        automation::list(&state.db).await.c(h!()).map_err(error)?;
    Ok(web::Json(automations))
}

#[post("/ui-api/automations")]
async fn create_automation(
    state: web::Data<AppState>,
    req: web::Json<SaveAutomationReq>,
) -> actix_web::Result<impl Responder> {
    let automation = automation::create(&state.db, req.into_inner())
        .await
        .c(h!())
        .map_err(error)?;
    Ok(web::Json(automation))
}

#[put("/ui-api/automations/{id}")]
async fn update_automation(
    state: web::Data<AppState>,
    path: web::Path<i64>,
    req: web::Json<SaveAutomationReq>,
) -> actix_web::Result<impl Responder> {
    let automation =
        automation::update(&state.db, path.into_inner(), req.into_inner())
            .await
            .c(h!())
            .map_err(error)?;
    Ok(web::Json(automation))
}

#[post("/ui-api/automations/{id}/pause")]
async fn pause_automation(
    state: web::Data<AppState>,
    path: web::Path<i64>,
    req: web::Json<PauseAutomationReq>,
) -> actix_web::Result<impl Responder> {
    let automation = automation::set_paused(
        &state.db,
        path.into_inner(),
        req.into_inner().is_paused,
    )
    .await
    .c(h!())
    .map_err(error)?;
    Ok(web::Json(automation))
}

#[delete("/ui-api/automations/{id}")]
async fn delete_automation(
    state: web::Data<AppState>,
    path: web::Path<i64>,
) -> actix_web::Result<impl Responder> {
    automation::delete(&state.db, path.into_inner())
        .await
        .c(h!())
        .map_err(error)?;
    Ok(HttpResponse::Ok().json(json!({ "ok": true })))
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
        .c(h!())
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PauseReq {
    is_paused: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PauseRsp {
    is_paused: bool,
}

#[post("/ui-api/messengers/{name}/pause")]
async fn pause_messenger(
    state: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Json<PauseReq>,
) -> actix_web::Result<impl Responder> {
    let is_paused = messenger::set_paused(
        &state.db,
        &path.into_inner(),
        req.into_inner().is_paused,
    )
    .await
    .c(h!())
    .map_err(error)?;
    Ok(web::Json(PauseRsp { is_paused }))
}

#[get("/ui-api/sync-pause")]
async fn global_pause_status(
    state: web::Data<AppState>,
) -> actix_web::Result<impl Responder> {
    let is_paused = messenger::global_is_paused(&state.db)
        .await
        .c(h!())
        .map_err(error)?;
    Ok(web::Json(PauseRsp { is_paused }))
}

#[post("/ui-api/sync-pause")]
async fn set_global_pause(
    state: web::Data<AppState>,
    req: web::Json<PauseReq>,
) -> actix_web::Result<impl Responder> {
    let is_paused =
        messenger::set_global_paused(&state.db, req.into_inner().is_paused)
            .await
            .c(h!())
            .map_err(error)?;
    Ok(web::Json(PauseRsp { is_paused }))
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
            .c(h!())
            .map_err(error)?;
    }
    let groups = messenger::groups(&state.db, &name, MessengerKind::Whatsapp)
        .await
        .c(h!())
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
                .c(h!())
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
    let attachments = prepare_whatsapp_attachments(req.screenshot)?;
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
    .c(h!())
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
        .c(h!())
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
            .c(h!())
            .map_err(error)?;
    }
    let groups = messenger::groups(&state.db, &name, MessengerKind::Signal)
        .await
        .c(h!())
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
            .c(h!())
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
    .c(h!())
    .map_err(error)?;
    Ok(HttpResponse::Created().json(json!({ "ok": true })))
}

async fn require_kind(
    state: &web::Data<AppState>,
    name: &str,
    kind: MessengerKind,
) -> actix_web::Result<messenger::MessengerView> {
    let messenger = messenger::load(&state.db, name)
        .await
        .c(h!())
        .map_err(error)?;
    if messenger.kind != kind {
        return Err(error(not_found(format!(
            "Месенджер «{name}» не використовує {}. Оновіть сторінку та виберіть потрібний месенджер ще раз.",
            kind.as_str()
        ))));
    }
    Ok(messenger)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorRsp {
    code: &'static str,
    message: String,
}

fn error(err: anyhow::Error) -> actix_web::Error {
    log::error!("echo-swapp API error: {err:#}");
    let (status, code, message) = error_response(&err);
    let response = HttpResponse::build(status).json(ErrorRsp { code, message });
    actix_web::error::InternalError::from_response(err, response).into()
}

fn error_response(err: &anyhow::Error) -> (StatusCode, &'static str, String) {
    let Some(err) = err.downcast_ref::<UserError>() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "Не вдалося виконати запит через внутрішню помилку. Повторіть спробу пізніше. Якщо помилка не зникне, зверніться до адміністратора."
                .to_string(),
        );
    };
    let (status, code) = match err.kind {
        UserErrorKind::BadRequest => (StatusCode::BAD_REQUEST, "bad_request"),
        UserErrorKind::NotFound => (StatusCode::NOT_FOUND, "not_found"),
        UserErrorKind::Conflict => (StatusCode::CONFLICT, "conflict"),
        UserErrorKind::ServiceUnavailable => {
            (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
        }
    };
    (status, code, err.to_string())
}

fn prepare_whatsapp_attachments(
    screenshot: Option<String>,
) -> actix_web::Result<Vec<String>> {
    let Some(screenshot) = screenshot else {
        return Ok(Vec::new());
    };
    let screenshot = screenshot.trim();
    if screenshot.is_empty() {
        return Ok(Vec::new());
    }
    let screenshot = strip_base64_data_uri(screenshot)?;
    general_purpose::STANDARD.decode(screenshot).map_err(|_| {
        error(bad_request(
            "Некоректні base64-дані знімка WhatsApp. Створіть знімок ще раз і повторіть відправлення.",
        ))
    })?;
    Ok(vec![screenshot.to_string()])
}

fn strip_base64_data_uri(screenshot: &str) -> actix_web::Result<&str> {
    let Some(data_uri) = screenshot.strip_prefix("data:") else {
        return Ok(screenshot);
    };
    let Some((metadata, content_base64)) = data_uri.split_once(',') else {
        return Err(error(bad_request(
            "Некоректний data URI знімка WhatsApp. Створіть знімок ще раз і повторіть відправлення.",
        )));
    };
    if !metadata
        .split(';')
        .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return Err(error(bad_request(
            "Data URI знімка WhatsApp має містити base64-дані. Створіть знімок ще раз і повторіть відправлення.",
        )));
    }
    Ok(content_base64.trim())
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
    fn user_error_returns_actionable_message_and_status() {
        let err = bad_request("Перевірте номер телефону та повторіть спробу.")
            .context("at goi/echo-swapp/src/api.rs line 73 column 12");
        let (status, code, message) = error_response(&err);

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(code, "bad_request");
        assert_eq!(message, "Перевірте номер телефону та повторіть спробу.");
    }

    #[test]
    fn internal_error_hides_sensitive_details() {
        let err = anyhow::anyhow!("password=secret")
            .context("at goi/echo-swapp/src/api.rs line 73 column 12");
        let (status, code, message) = error_response(&err);

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(code, "internal_error");
        assert!(!message.contains("secret"));
        assert!(!message.contains("api.rs"));
    }

    #[test]
    fn prepares_raw_base64_whatsapp_screenshot() {
        let attachments =
            prepare_whatsapp_attachments(Some(" YWJj ".to_string())).unwrap();

        assert_eq!(attachments, vec!["YWJj"]);
    }

    #[test]
    fn strips_whatsapp_screenshot_data_uri_header() {
        let attachments = prepare_whatsapp_attachments(Some(
            "data:image/png;base64,YWJj".to_string(),
        ))
        .unwrap();

        assert_eq!(attachments, vec!["YWJj"]);
    }

    #[test]
    fn skips_empty_whatsapp_screenshot() {
        let attachments =
            prepare_whatsapp_attachments(Some(" ".to_string())).unwrap();

        assert!(attachments.is_empty());
    }

    #[test]
    fn rejects_non_base64_whatsapp_screenshot_data_uri() {
        let err = prepare_whatsapp_attachments(Some(
            "data:image/png,abc".to_string(),
        ))
        .unwrap_err();

        assert_eq!(err.as_response_error().status_code(), 400);
    }

    #[test]
    fn rejects_invalid_whatsapp_screenshot_base64() {
        let err = prepare_whatsapp_attachments(Some(
            "data:image/png;base64,not base64".to_string(),
        ))
        .unwrap_err();

        assert_eq!(err.as_response_error().status_code(), 400);
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
