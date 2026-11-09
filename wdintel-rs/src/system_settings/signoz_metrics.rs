//! SigNoz metrics export settings, edited on the admin system settings page.
//!
//! They used to live in config.toml. A null column means the setting was
//! never saved: startup then imports the legacy config.toml values into the
//! active row, and until that happens the legacy values still apply.

use super::{get_active_system_settings, normalize_optional_setting};
use crate::config::Config;
use crate::entities::system_settings;
use crate::error::AppError;
use crate::h;
use crate::system_settings::types::CreateSystemSettingsReq;
use crate::telemetry::{
    is_valid_signoz_metrics_endpoint, SignozMetricsSettings,
};
use crate::types::ShortContext;
use log::{info, warn};
use sea_orm::{
    sea_query::Expr, ActiveValue::Set, ColumnTrait, ConnectionTrait,
    EntityTrait, QueryFilter,
};

fn saved(settings: &system_settings::Model) -> Option<SignozMetricsSettings> {
    settings
        .signoz_metrics_enabled
        .map(|enabled| SignozMetricsSettings {
            enabled,
            endpoint: settings.signoz_metrics_endpoint.clone(),
        })
}

fn legacy(config: &Config) -> Option<SignozMetricsSettings> {
    if config.signoz_metrics_enabled.is_none()
        && config.signoz_metrics_endpoint.is_none()
    {
        return None;
    }
    Some(SignozMetricsSettings {
        enabled: config.signoz_metrics_enabled.unwrap_or(false),
        endpoint: normalize_optional_setting(
            config.signoz_metrics_endpoint.as_deref(),
        ),
    })
}

/// What the exporter uses at process start: the saved settings, otherwise
/// the legacy config.toml values.
///
/// A failed read also falls back, because the report worker does not run
/// migrations and can start before the columns exist.
pub async fn effective<C>(dbx: &C, config: &Config) -> SignozMetricsSettings
where
    C: ConnectionTrait,
{
    let saved = match get_active_system_settings(dbx).await {
        Ok(settings) => settings.as_ref().and_then(saved),
        Err(error) => {
            warn!(
                "Reading Signoz metrics settings failed, using config.toml: {error:?}"
            );
            None
        }
    };
    saved.or_else(|| legacy(config)).unwrap_or_default()
}

/// Copies legacy config.toml values into the active settings, once.
pub async fn import_legacy_config<C>(
    dbx: &C,
    config: &Config,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    let Some(legacy) = legacy(config) else {
        return Ok(());
    };
    let Some(active) = get_active_system_settings(dbx).await.c(h!())? else {
        return Ok(());
    };
    if active.signoz_metrics_enabled.is_some() {
        info!(
            "config.toml signoz_metrics_enabled and signoz_metrics_endpoint are ignored, because system settings define Signoz metrics; remove them from config.toml"
        );
        return Ok(());
    }
    let imported = system_settings::Entity::update_many()
        .col_expr(
            system_settings::Column::SignozMetricsEnabled,
            Expr::value(legacy.enabled),
        )
        .col_expr(
            system_settings::Column::SignozMetricsEndpoint,
            Expr::value(legacy.endpoint),
        )
        .filter(system_settings::Column::Deleted.eq(false))
        .filter(system_settings::Column::SignozMetricsEnabled.is_null())
        .exec(dbx)
        .await
        .c(h!())?;
    if imported.rows_affected > 0 {
        info!(
            "Imported Signoz metrics settings from config.toml into system settings; remove signoz_metrics_enabled and signoz_metrics_endpoint from config.toml"
        );
    }
    Ok(())
}

/// Keeps the saved values when an older client omits them, and checks new
/// ones.
pub(super) fn reconcile(
    req: &mut CreateSystemSettingsReq,
    settings: Option<&system_settings::Model>,
) -> Result<(), AppError> {
    if req.signoz_metrics_enabled.is_none() {
        req.signoz_metrics_enabled =
            settings.and_then(|settings| settings.signoz_metrics_enabled);
        req.signoz_metrics_endpoint = settings
            .and_then(|settings| settings.signoz_metrics_endpoint.clone());
        return Ok(());
    }
    req.signoz_metrics_endpoint =
        normalize_optional_setting(req.signoz_metrics_endpoint.as_deref());
    if let Some(endpoint) = &req.signoz_metrics_endpoint {
        if !is_valid_signoz_metrics_endpoint(endpoint) {
            return Err(AppError::BL {
                msg: "Адреса SigNoz має бути http або https URL, наприклад http://signoz-echo.eagle-atria.ts.net:4317".to_string(),
            });
        }
    }
    if req.signoz_metrics_enabled == Some(true)
        && req.signoz_metrics_endpoint.is_none()
    {
        return Err(AppError::BL {
            msg: "Вкажіть адресу SigNoz, щоб увімкнути експорт метрик"
                .to_string(),
        });
    }
    Ok(())
}

/// Activating a revision saved before these settings existed keeps the
/// current ones instead of switching export off.
pub(super) fn carry_over_on_activation(
    target: &system_settings::Model,
    target_act: &mut system_settings::ActiveModel,
    active: Option<&system_settings::Model>,
) {
    if target.signoz_metrics_enabled.is_some() {
        return;
    }
    if let Some(active) = active {
        target_act.signoz_metrics_enabled = Set(active.signoz_metrics_enabled);
        target_act.signoz_metrics_endpoint =
            Set(active.signoz_metrics_endpoint.clone());
    }
}
