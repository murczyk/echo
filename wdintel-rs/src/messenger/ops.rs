use crate::entities::sea_orm_active_enums::AccountStatus;
use crate::types::*;
use sea_orm::ActiveEnum;
use tokio::process::Command;

pub async fn restart_whatsapp_units(mode: Mode) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let active_status = AccountStatus::Active.into_value().value.into_owned();
    let whatsapp_units: Vec<_> = super::bl::list_echo_accounts(None, &dbx)
        .await
        .c(h!())?
        .into_iter()
        .filter(|account| account.messenger.eq_ignore_ascii_case("whatsapp"))
        .filter(|account| account.status == active_status)
        .filter(|account| account.process_name.is_some())
        .collect();

    if whatsapp_units.is_empty() {
        println!("no active whatsapp units to restart");
        return Ok(());
    }

    for account in whatsapp_units {
        let process_name = account.process_name.c(h!())?;
        let system_service_name = account
            .system_service_name
            .unwrap_or_else(|| "unknown".to_string());
        println!(
            "restarting whatsapp unit {process_name} (service={system_service_name}, display_name={})",
            account.display_name
        );
        let status = Command::new("sudo")
            .args(["systemctl", "restart", &process_name])
            .status()
            .await
            .context(h!())?;
        if !status.success() {
            let code = status.code().unwrap_or(-1);
            return Err(AppError::BL {
                msg: format!(
                    "failed to restart unit {process_name}, code={code}"
                ),
            });
        }
    }

    Ok(())
}
