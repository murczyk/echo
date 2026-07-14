pub mod types;
pub mod worker;

use crate::entities::system_settings;
use crate::error::AppError;
use crate::h;
use crate::system_settings::types::{
    ActivateSystemSettingsReq, CreateSystemSettingsReq,
    SystemSettingsCurrentRsp, SystemSettingsItem, SystemSettingsListRsp,
};
use crate::types::Env;
use crate::types::ShortContext;
use actix_identity::Identity;
use actix_web::{post, web::Json};
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, TransactionTrait,
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PelengBounds {
    min_lat: f64,
    max_lat: f64,
    min_lng: f64,
    max_lng: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EchoImSyncCursor {
    pub created_at: chrono::NaiveDateTime,
    pub inbox_message_id: i32,
}

impl PelengBounds {
    fn from_corners(
        top_left_lat: f64,
        top_left_lng: f64,
        bottom_right_lat: f64,
        bottom_right_lng: f64,
    ) -> Self {
        Self {
            min_lat: top_left_lat.min(bottom_right_lat),
            max_lat: top_left_lat.max(bottom_right_lat),
            min_lng: top_left_lng.min(bottom_right_lng),
            max_lng: top_left_lng.max(bottom_right_lng),
        }
    }

    pub fn contains(&self, lat: f64, lng: f64) -> bool {
        lat >= self.min_lat
            && lat <= self.max_lat
            && lng >= self.min_lng
            && lng <= self.max_lng
    }
}

fn map_system_settings_item(
    settings: system_settings::Model,
) -> Result<SystemSettingsItem, AppError> {
    Ok(SystemSettingsItem {
        id: settings.id,
        rer_analysis_units_exact_match_only_default: settings
            .rer_analysis_units_exact_match_only_default,
        rer_duty_test_enabled: settings.rer_duty_test_enabled,
        rer_duty_insert_historical_interceptions: settings
            .rer_duty_insert_historical_interceptions,
        rer_duty_test_since_ms: settings.rer_duty_test_since_ms,
        rer_duty_test_limit: settings.rer_duty_test_limit,
        rer_duty_poll_interval_sec: settings.rer_duty_poll_interval_sec,
        created_at: settings.created_at.and_utc().timestamp_millis(),
        updated_at: settings.updated_at.and_utc().timestamp_millis(),
        updated_by: settings.updated_by,
        deleted: settings.deleted,
        short_url_enabled: settings.short_url_enabled,
        support_non_rer_interceptions: settings.support_non_rer_interceptions,
        default_neo_analysis: settings.default_neo_analysis,
        autofix_echoim_missing_messages: settings
            .autofix_echoim_missing_messages,
        peleng_bounds_enabled: settings.peleng_bounds_enabled,
        peleng_bounds_top_left_lat: settings.peleng_bounds_top_left_lat,
        peleng_bounds_top_left_lng: settings.peleng_bounds_top_left_lng,
        peleng_bounds_bottom_right_lat: settings.peleng_bounds_bottom_right_lat,
        peleng_bounds_bottom_right_lng: settings.peleng_bounds_bottom_right_lng,
        devices_section_enabled: settings.devices_section_enabled,
        echo_restapi_error_discord_webhook_url: settings
            .echo_restapi_error_discord_webhook_url,
        sigint_comment_parsing_enabled: settings.sigint_comment_parsing_enabled,
        do_not_store_duplicate_echoim_failures: settings
            .do_not_store_duplicate_echoim_failures,
    })
}

fn normalize_optional_setting(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub async fn get_active_system_settings<C>(
    dbx: &C,
) -> Result<Option<system_settings::Model>, AppError>
where
    C: ConnectionTrait,
{
    Ok(system_settings::Entity::find()
        .filter(system_settings::Column::Deleted.eq(false))
        .order_by_desc(system_settings::Column::UpdatedAt)
        .one(dbx)
        .await
        .c(h!())?)
}

pub async fn get_echo_im_sync_since<C>(
    dbx: &C,
) -> Result<chrono::NaiveDateTime, AppError>
where
    C: ConnectionTrait,
{
    Ok(get_echo_im_sync_cursor(dbx).await?.created_at)
}

pub async fn get_echo_restapi_error_discord_webhook_url<C>(
    dbx: &C,
) -> Result<Option<String>, AppError>
where
    C: ConnectionTrait,
{
    Ok(get_active_system_settings(dbx)
        .await
        .c(h!())?
        .and_then(|settings| {
            normalize_optional_setting(
                settings.echo_restapi_error_discord_webhook_url.as_deref(),
            )
        }))
}

pub async fn get_echo_im_sync_cursor<C>(
    dbx: &C,
) -> Result<EchoImSyncCursor, AppError>
where
    C: ConnectionTrait,
{
    Ok(get_active_system_settings(dbx)
        .await
        .c(h!())?
        .map(|settings| EchoImSyncCursor {
            created_at: settings.echo_im_sync_since,
            inbox_message_id: settings.echo_im_sync_since_inbox_message_id,
        })
        .unwrap_or_else(|| EchoImSyncCursor {
            created_at: now_utc(),
            inbox_message_id: 0,
        }))
}

pub async fn advance_echo_im_sync_since<C>(
    dbx: &C,
    next_sync_since: chrono::NaiveDateTime,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    advance_echo_im_sync_cursor(
        dbx,
        EchoImSyncCursor {
            created_at: next_sync_since,
            inbox_message_id: 0,
        },
    )
    .await
}

pub async fn advance_echo_im_sync_cursor<C>(
    dbx: &C,
    next_cursor: EchoImSyncCursor,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    let Some(settings) = get_active_system_settings(dbx).await.c(h!())? else {
        return Ok(());
    };
    let current_cursor = EchoImSyncCursor {
        created_at: settings.echo_im_sync_since,
        inbox_message_id: settings.echo_im_sync_since_inbox_message_id,
    };
    if cursor_lte(next_cursor, current_cursor) {
        return Ok(());
    }
    let mut settings: system_settings::ActiveModel = settings.into();
    settings.echo_im_sync_since = Set(next_cursor.created_at);
    settings.echo_im_sync_since_inbox_message_id =
        Set(next_cursor.inbox_message_id);
    settings.update(dbx).await.c(h!())?;
    Ok(())
}

fn cursor_lte(left: EchoImSyncCursor, right: EchoImSyncCursor) -> bool {
    left.created_at < right.created_at
        || (left.created_at == right.created_at
            && left.inbox_message_id <= right.inbox_message_id)
}

pub async fn autofix_echoim_missing_messages_enabled<C>(
    dbx: &C,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let settings = get_active_system_settings(dbx).await.c(h!())?;
    Ok(settings
        .map(|settings| settings.autofix_echoim_missing_messages)
        .unwrap_or(false))
}

pub async fn do_not_store_duplicate_echoim_failures_enabled<C>(
    dbx: &C,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let settings = get_active_system_settings(dbx).await.c(h!())?;
    Ok(settings
        .map(|settings| settings.do_not_store_duplicate_echoim_failures)
        .unwrap_or(false))
}

pub async fn get_rer_analysis_units_exact_match_only_default<C>(
    dbx: &C,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let settings = get_active_system_settings(dbx).await.c(h!())?;
    Ok(settings
        .map(|settings| settings.rer_analysis_units_exact_match_only_default)
        .unwrap_or(true))
}

pub async fn support_non_rer_interceptions_enabled<C>(
    dbx: &C,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let settings = get_active_system_settings(dbx).await.c(h!())?;
    Ok(settings
        .map(|settings| settings.support_non_rer_interceptions)
        .unwrap_or(false))
}

pub async fn ensure_support_non_rer_interceptions_enabled<C>(
    dbx: &C,
) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if support_non_rer_interceptions_enabled(dbx).await.c(h!())? {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "support_non_rer_interceptions is disabled".to_string(),
        ))
    }
}

pub async fn devices_section_enabled<C>(dbx: &C) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let settings = get_active_system_settings(dbx).await.c(h!())?;
    Ok(settings
        .map(|settings| settings.devices_section_enabled)
        .unwrap_or(false))
}

pub async fn sigint_comment_parsing_enabled<C>(
    dbx: &C,
) -> Result<bool, AppError>
where
    C: ConnectionTrait,
{
    let settings = get_active_system_settings(dbx).await.c(h!())?;
    Ok(settings
        .map(|settings| settings.sigint_comment_parsing_enabled)
        .unwrap_or(false))
}

pub async fn ensure_devices_section_enabled<C>(dbx: &C) -> Result<(), AppError>
where
    C: ConnectionTrait,
{
    if devices_section_enabled(dbx).await.c(h!())? {
        Ok(())
    } else {
        Err(AppError::Forbidden(
            "devices_section_enabled is disabled".to_string(),
        ))
    }
}

fn peleng_bounds_from_settings(
    settings: &system_settings::Model,
) -> Option<PelengBounds> {
    if !settings.peleng_bounds_enabled {
        return None;
    }

    let top_left_lat = settings.peleng_bounds_top_left_lat?;
    let top_left_lng = settings.peleng_bounds_top_left_lng?;
    let bottom_right_lat = settings.peleng_bounds_bottom_right_lat?;
    let bottom_right_lng = settings.peleng_bounds_bottom_right_lng?;

    if ![
        top_left_lat,
        top_left_lng,
        bottom_right_lat,
        bottom_right_lng,
    ]
    .iter()
    .all(|value| value.is_finite())
    {
        return None;
    }

    Some(PelengBounds::from_corners(
        top_left_lat,
        top_left_lng,
        bottom_right_lat,
        bottom_right_lng,
    ))
}

pub async fn get_active_peleng_bounds<C>(
    dbx: &C,
) -> Result<Option<PelengBounds>, AppError>
where
    C: ConnectionTrait,
{
    let settings = get_active_system_settings(dbx).await.c(h!())?;
    Ok(settings.as_ref().and_then(peleng_bounds_from_settings))
}

fn validate_coordinate(
    label: &str,
    value: Option<f64>,
    min: f64,
    max: f64,
) -> Result<f64, AppError> {
    let value = value.ok_or_else(|| AppError::BL {
        msg: format!("{label} не задана"),
    })?;

    if value.is_finite() && value >= min && value <= max {
        Ok(value)
    } else {
        Err(AppError::BL {
            msg: format!("{label} має бути в межах від {min} до {max}"),
        })
    }
}

fn validate_peleng_bounds(
    req: &CreateSystemSettingsReq,
) -> Result<(), AppError> {
    if !req.peleng_bounds_enabled {
        return Ok(());
    }

    validate_coordinate(
        "Широта верхнього лівого кута",
        req.peleng_bounds_top_left_lat,
        -90.0,
        90.0,
    )?;
    validate_coordinate(
        "Довгота верхнього лівого кута",
        req.peleng_bounds_top_left_lng,
        -180.0,
        180.0,
    )?;
    validate_coordinate(
        "Широта нижнього правого кута",
        req.peleng_bounds_bottom_right_lat,
        -90.0,
        90.0,
    )?;
    validate_coordinate(
        "Довгота нижнього правого кута",
        req.peleng_bounds_bottom_right_lng,
        -180.0,
        180.0,
    )?;

    Ok(())
}

fn system_settings_active_model(
    login: &str,
    req: &CreateSystemSettingsReq,
    echo_im_sync_cursor: EchoImSyncCursor,
) -> system_settings::ActiveModel {
    system_settings::ActiveModel {
        id: sea_orm::ActiveValue::NotSet,
        rer_analysis_units_exact_match_only_default: Set(
            req.rer_analysis_units_exact_match_only_default
        ),
        rer_duty_test_enabled: Set(req.rer_duty_test_enabled),
        rer_duty_insert_historical_interceptions: Set(
            req.rer_duty_insert_historical_interceptions
        ),
        rer_duty_test_since_ms: Set(req.rer_duty_test_since_ms),
        rer_duty_test_limit: Set(req.rer_duty_test_limit),
        rer_duty_poll_interval_sec: Set(req.rer_duty_poll_interval_sec.max(1)),
        created_at: sea_orm::ActiveValue::NotSet,
        updated_at: sea_orm::ActiveValue::NotSet,
        echo_im_sync_since: Set(echo_im_sync_cursor.created_at),
        echo_im_sync_since_inbox_message_id: Set(
            echo_im_sync_cursor.inbox_message_id
        ),
        updated_by: Set(Some(login.to_string())),
        deleted: Set(false),
        short_url_enabled: Set(req.short_url_enabled),
        support_non_rer_interceptions: Set(req.support_non_rer_interceptions),
        default_neo_analysis: Set(req.default_neo_analysis),
        autofix_echoim_missing_messages: Set(
            req.autofix_echoim_missing_messages
        ),
        peleng_bounds_enabled: Set(req.peleng_bounds_enabled),
        peleng_bounds_top_left_lat: Set(req.peleng_bounds_top_left_lat),
        peleng_bounds_top_left_lng: Set(req.peleng_bounds_top_left_lng),
        peleng_bounds_bottom_right_lat: Set(req.peleng_bounds_bottom_right_lat),
        peleng_bounds_bottom_right_lng: Set(req.peleng_bounds_bottom_right_lng),
        devices_section_enabled: Set(req.devices_section_enabled),
        echo_restapi_error_discord_webhook_url: Set(
            normalize_optional_setting(
                req.echo_restapi_error_discord_webhook_url.as_deref(),
            ),
        ),
        sigint_comment_parsing_enabled: Set(req.sigint_comment_parsing_enabled),
        do_not_store_duplicate_echoim_failures: Set(
            req.do_not_store_duplicate_echoim_failures
        ),
    }
}

fn now_utc() -> chrono::NaiveDateTime {
    Utc::now().naive_utc()
}

async fn deactivate_active_settings<C>(
    dbx: &C,
    updated_by: &str,
) -> Result<(), AppError>
where
    C: sea_orm::ConnectionTrait,
{
    let active_rows = system_settings::Entity::find()
        .filter(system_settings::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;

    for row in active_rows {
        let mut row: system_settings::ActiveModel = row.into();
        row.deleted = Set(true);
        row.updated_by = Set(Some(updated_by.to_string()));
        row.updated_at = Set(now_utc());
        row.update(dbx).await.c(h!())?;
    }

    Ok(())
}

async fn create_system_settings_for_login(
    dbx: &DatabaseConnection,
    login: &str,
    req: &CreateSystemSettingsReq,
) -> Result<system_settings::Model, AppError> {
    validate_peleng_bounds(req)?;
    let txn = dbx.begin().await.c(h!())?;
    let echo_im_sync_cursor = get_echo_im_sync_cursor(&txn).await.c(h!())?;
    deactivate_active_settings(&txn, login).await.c(h!())?;
    let created = system_settings_active_model(login, req, echo_im_sync_cursor)
        .insert(&txn)
        .await
        .c(h!())?;
    if created.do_not_store_duplicate_echoim_failures {
        crate::messenger::missing_message::delete_duplicate_missing_messages(
            &txn,
        )
        .await
        .c(h!())?;
    }
    txn.commit().await.c(h!())?;

    Ok(created)
}

async fn activate_system_settings_for_login(
    dbx: &DatabaseConnection,
    login: &str,
    id: i64,
) -> Result<system_settings::Model, AppError> {
    let txn = dbx.begin().await.c(h!())?;
    let echo_im_sync_cursor = get_echo_im_sync_cursor(&txn).await.c(h!())?;
    deactivate_active_settings(&txn, login).await.c(h!())?;

    let settings = system_settings::Entity::find_by_id(id)
        .one(&txn)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)?;

    let mut settings: system_settings::ActiveModel = settings.into();
    settings.deleted = Set(false);
    settings.updated_by = Set(Some(login.to_string()));
    settings.updated_at = Set(now_utc());
    settings.echo_im_sync_since = Set(echo_im_sync_cursor.created_at);
    settings.echo_im_sync_since_inbox_message_id =
        Set(echo_im_sync_cursor.inbox_message_id);
    let settings = settings.update(&txn).await.c(h!())?;
    if settings.do_not_store_duplicate_echoim_failures {
        crate::messenger::missing_message::delete_duplicate_missing_messages(
            &txn,
        )
        .await
        .c(h!())?;
    }
    txn.commit().await.c(h!())?;

    Ok(settings)
}

#[post("/api/system-settings/current")]
pub async fn current_system_settings(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<SystemSettingsCurrentRsp>, AppError> {
    let _login = user.id().c(h!())?;
    let settings = get_active_system_settings(&env.dbx).await.c(h!())?;
    Ok(Json(match settings {
        Some(settings) => SystemSettingsCurrentRsp {
            id: Some(settings.id),
            rer_analysis_units_exact_match_only_default: settings
                .rer_analysis_units_exact_match_only_default,
            rer_duty_test_enabled: settings.rer_duty_test_enabled,
            rer_duty_insert_historical_interceptions: settings
                .rer_duty_insert_historical_interceptions,
            rer_duty_test_since_ms: settings.rer_duty_test_since_ms,
            rer_duty_test_limit: settings.rer_duty_test_limit,
            rer_duty_poll_interval_sec: settings.rer_duty_poll_interval_sec,
            short_url_enabled: settings.short_url_enabled,
            support_non_rer_interceptions: settings
                .support_non_rer_interceptions,
            default_neo_analysis: settings.default_neo_analysis,
            autofix_echoim_missing_messages: settings
                .autofix_echoim_missing_messages,
            peleng_bounds_enabled: settings.peleng_bounds_enabled,
            peleng_bounds_top_left_lat: settings.peleng_bounds_top_left_lat,
            peleng_bounds_top_left_lng: settings.peleng_bounds_top_left_lng,
            peleng_bounds_bottom_right_lat: settings
                .peleng_bounds_bottom_right_lat,
            peleng_bounds_bottom_right_lng: settings
                .peleng_bounds_bottom_right_lng,
            devices_section_enabled: settings.devices_section_enabled,
            sigint_comment_parsing_enabled: settings
                .sigint_comment_parsing_enabled,
            do_not_store_duplicate_echoim_failures: settings
                .do_not_store_duplicate_echoim_failures,
        },
        None => SystemSettingsCurrentRsp {
            id: None,
            rer_analysis_units_exact_match_only_default: true,
            rer_duty_test_enabled: false,
            rer_duty_insert_historical_interceptions: false,
            rer_duty_test_since_ms: 0,
            rer_duty_test_limit: 1,
            rer_duty_poll_interval_sec: 1,
            short_url_enabled: false,
            support_non_rer_interceptions: false,
            default_neo_analysis: false,
            autofix_echoim_missing_messages: false,
            peleng_bounds_enabled: false,
            peleng_bounds_top_left_lat: None,
            peleng_bounds_top_left_lng: None,
            peleng_bounds_bottom_right_lat: None,
            peleng_bounds_bottom_right_lng: None,
            devices_section_enabled: false,
            sigint_comment_parsing_enabled: false,
            do_not_store_duplicate_echoim_failures: false,
        },
    }))
}

#[post("/api/admin/system-settings/list")]
pub async fn list_system_settings(
    user: Identity,
    env: actix_web::web::Data<Env>,
) -> Result<Json<SystemSettingsListRsp>, AppError> {
    crate::users::has_role(&env.dbx, &user.id().c(h!())?, "Admin")
        .await
        .c(h!())?;

    let items: Vec<SystemSettingsItem> = system_settings::Entity::find()
        .order_by_desc(system_settings::Column::Deleted)
        .order_by_desc(system_settings::Column::UpdatedAt)
        .all(&env.dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(map_system_settings_item)
        .collect::<Result<Vec<_>, _>>()
        .c(h!())?;

    Ok(Json(SystemSettingsListRsp { items }))
}

#[post("/api/admin/system-settings/create")]
pub async fn create_system_settings(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<CreateSystemSettingsReq>,
) -> Result<Json<SystemSettingsItem>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;

    let created =
        create_system_settings_for_login(&env.dbx, &login, &req).await?;

    Ok(Json(map_system_settings_item(created)?))
}

#[post("/api/admin/system-settings/activate")]
pub async fn activate_system_settings(
    user: Identity,
    env: actix_web::web::Data<Env>,
    req: Json<ActivateSystemSettingsReq>,
) -> Result<Json<SystemSettingsItem>, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Admin")
        .await
        .c(h!())?;

    let settings =
        activate_system_settings_for_login(&env.dbx, &login, req.id).await?;

    Ok(Json(map_system_settings_item(settings)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::echo_missing_message;
    use crate::entities::sea_orm_active_enums::EchoMissingMessageStatus;
    use crate::functest::tests::cleanup;
    use sea_orm::*;
    use serial_test::serial;

    static TEST_LOCK: tokio::sync::Mutex<()> =
        tokio::sync::Mutex::const_new(());

    #[tokio::test]
    #[serial]
    async fn echo_im_sync_cursor_advances_only_forward() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        system_settings::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let created_at = old_ts();
        let cursor = EchoImSyncCursor {
            created_at,
            inbox_message_id: 10,
        };
        insert_settings_with_cursor(&env.dbx, cursor, false).await;

        advance_echo_im_sync_since(
            &env.dbx,
            created_at - chrono::TimeDelta::minutes(1),
        )
        .await
        .unwrap();
        assert_eq!(get_echo_im_sync_cursor(&env.dbx).await.unwrap(), cursor);

        advance_echo_im_sync_cursor(
            &env.dbx,
            EchoImSyncCursor {
                created_at,
                inbox_message_id: 9,
            },
        )
        .await
        .unwrap();
        assert_eq!(get_echo_im_sync_cursor(&env.dbx).await.unwrap(), cursor);

        let same_created_at_next_id = EchoImSyncCursor {
            created_at,
            inbox_message_id: 11,
        };
        advance_echo_im_sync_cursor(&env.dbx, same_created_at_next_id)
            .await
            .unwrap();
        assert_eq!(
            get_echo_im_sync_cursor(&env.dbx).await.unwrap(),
            same_created_at_next_id
        );

        let next_cursor = created_at + chrono::TimeDelta::minutes(1);
        advance_echo_im_sync_since(&env.dbx, next_cursor)
            .await
            .unwrap();
        assert_eq!(
            get_echo_im_sync_since(&env.dbx).await.unwrap(),
            next_cursor
        );
    }

    #[tokio::test]
    #[serial]
    async fn create_and_activate_settings_preserve_active_echo_im_sync_cursor()
    {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        system_settings::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        let active_cursor = old_ts();
        let active_cursor_id = 42;
        let stale_cursor = active_cursor - chrono::TimeDelta::hours(1);
        insert_settings_with_cursor(
            &env.dbx,
            EchoImSyncCursor {
                created_at: active_cursor,
                inbox_message_id: active_cursor_id,
            },
            false,
        )
        .await;
        let inactive = insert_settings(&env.dbx, stale_cursor, true).await;

        let created = create_system_settings_for_login(
            &env.dbx,
            "Tester",
            &settings_req(false),
        )
        .await
        .unwrap();
        assert_eq!(created.echo_im_sync_since, active_cursor);
        assert_eq!(
            created.echo_im_sync_since_inbox_message_id,
            active_cursor_id
        );

        advance_echo_im_sync_cursor(
            &env.dbx,
            EchoImSyncCursor {
                created_at: active_cursor + chrono::TimeDelta::minutes(5),
                inbox_message_id: 77,
            },
        )
        .await
        .unwrap();
        let current_cursor = get_echo_im_sync_cursor(&env.dbx).await.unwrap();
        let activated =
            activate_system_settings_for_login(&env.dbx, "Tester", inactive.id)
                .await
                .unwrap();

        assert_eq!(activated.echo_im_sync_since, current_cursor.created_at);
        assert_eq!(
            activated.echo_im_sync_since_inbox_message_id,
            current_cursor.inbox_message_id
        );
        assert_eq!(
            get_active_system_settings(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .id,
            inactive.id
        );
    }

    #[tokio::test]
    #[serial]
    async fn create_settings_deletes_duplicate_missing_messages_when_enabled() {
        let _guard = TEST_LOCK.lock().await;
        let env = cleanup().await.unwrap();
        system_settings::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        echo_missing_message::Entity::delete_many()
            .exec(&env.dbx)
            .await
            .unwrap();
        insert_missing_message(
            &env.dbx,
            -1,
            EchoMissingMessageStatus::Duplicate,
        )
        .await;
        insert_missing_message(&env.dbx, -2, EchoMissingMessageStatus::Pending)
            .await;
        let mut req = settings_req(false);
        req.do_not_store_duplicate_echoim_failures = true;

        create_system_settings_for_login(&env.dbx, "Tester", &req)
            .await
            .unwrap();

        assert_eq!(
            echo_missing_message::Entity::find()
                .filter(
                    echo_missing_message::Column::Status
                        .eq(EchoMissingMessageStatus::Duplicate)
                )
                .count(&env.dbx)
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            echo_missing_message::Entity::find()
                .filter(echo_missing_message::Column::MessageId.eq(-2))
                .count(&env.dbx)
                .await
                .unwrap(),
            1
        );
    }

    fn old_ts() -> chrono::NaiveDateTime {
        chrono::DateTime::<chrono::Utc>::from_timestamp_micros(
            Utc::now().timestamp_micros(),
        )
        .unwrap()
        .naive_utc()
            - chrono::TimeDelta::hours(2)
    }

    fn settings_req(short_url_enabled: bool) -> CreateSystemSettingsReq {
        CreateSystemSettingsReq {
            rer_analysis_units_exact_match_only_default: true,
            rer_duty_test_enabled: false,
            rer_duty_insert_historical_interceptions: false,
            rer_duty_test_since_ms: 0,
            rer_duty_test_limit: 1,
            rer_duty_poll_interval_sec: 1,
            short_url_enabled,
            support_non_rer_interceptions: false,
            default_neo_analysis: false,
            autofix_echoim_missing_messages: false,
            devices_section_enabled: false,
            peleng_bounds_enabled: false,
            peleng_bounds_top_left_lat: None,
            peleng_bounds_top_left_lng: None,
            peleng_bounds_bottom_right_lat: None,
            peleng_bounds_bottom_right_lng: None,
            echo_restapi_error_discord_webhook_url: None,
            sigint_comment_parsing_enabled: true,
            do_not_store_duplicate_echoim_failures: false,
        }
    }

    async fn insert_settings(
        dbx: &DatabaseConnection,
        echo_im_sync_since: chrono::NaiveDateTime,
        deleted: bool,
    ) -> system_settings::Model {
        insert_settings_with_cursor(
            dbx,
            EchoImSyncCursor {
                created_at: echo_im_sync_since,
                inbox_message_id: 0,
            },
            deleted,
        )
        .await
    }

    async fn insert_settings_with_cursor(
        dbx: &DatabaseConnection,
        echo_im_sync_cursor: EchoImSyncCursor,
        deleted: bool,
    ) -> system_settings::Model {
        system_settings::ActiveModel {
            id: NotSet,
            rer_analysis_units_exact_match_only_default: Set(true),
            created_at: Set(Utc::now().naive_utc()),
            updated_at: Set(Utc::now().naive_utc()),
            echo_im_sync_since: Set(echo_im_sync_cursor.created_at),
            echo_im_sync_since_inbox_message_id: Set(
                echo_im_sync_cursor.inbox_message_id
            ),
            updated_by: Set(None),
            deleted: Set(deleted),
            rer_duty_test_enabled: Set(false),
            rer_duty_test_since_ms: Set(0),
            rer_duty_test_limit: Set(1),
            rer_duty_poll_interval_sec: Set(1),
            rer_duty_insert_historical_interceptions: Set(false),
            short_url_enabled: Set(false),
            support_non_rer_interceptions: Set(false),
            peleng_bounds_enabled: Set(false),
            peleng_bounds_top_left_lat: Set(None),
            peleng_bounds_top_left_lng: Set(None),
            peleng_bounds_bottom_right_lat: Set(None),
            peleng_bounds_bottom_right_lng: Set(None),
            default_neo_analysis: Set(false),
            autofix_echoim_missing_messages: Set(false),
            devices_section_enabled: Set(false),
            echo_restapi_error_discord_webhook_url: Set(None),
            sigint_comment_parsing_enabled: Set(true),
            do_not_store_duplicate_echoim_failures: Set(false),
        }
        .insert(dbx)
        .await
        .unwrap()
    }

    async fn insert_missing_message(
        dbx: &DatabaseConnection,
        message_id: i32,
        status: EchoMissingMessageStatus,
    ) -> echo_missing_message::Model {
        let is_resolved = matches!(
            status,
            EchoMissingMessageStatus::Resolved
                | EchoMissingMessageStatus::Deleted
                | EchoMissingMessageStatus::Duplicate
        );
        echo_missing_message::ActiveModel {
            id: NotSet,
            message_id: Set(message_id),
            created_at: Set(Utc::now().naive_utc()),
            is_resolved: Set(is_resolved),
            resolved_at: Set(if is_resolved {
                Some(Utc::now().naive_utc())
            } else {
                None
            }),
            scheduled_by: Set(None),
            status: Set(status),
            error: Set(None),
        }
        .insert(dbx)
        .await
        .unwrap()
    }
}
