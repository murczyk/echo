use crate::entities::signal_group;
use crate::rer_importer::types::InboxSubmitItem;
use crate::types::*;
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, EntityTrait, IntoActiveModel, Set,
};

pub async fn set<C: ConnectionTrait>(
    db: &C,
    master_key: &str,
    is_sigint_unit_mandatory: Option<bool>,
    is_device_mandatory: Option<bool>,
) -> anyhow::Result<(bool, bool)> {
    let group = signal_group::Entity::find_by_id(master_key)
        .one(db)
        .await
        .c(h!())?
        .ok_or(AppError::NotFound)
        .c(h!())?;
    let mut group = group.into_active_model();
    if let Some(value) = is_sigint_unit_mandatory {
        group.is_sigint_unit_mandatory = Set(Some(value));
    }
    if let Some(value) = is_device_mandatory {
        group.is_device_mandatory = Set(Some(value));
    }
    let group = group.update(db).await.c(h!())?;
    Ok((
        group.is_sigint_unit_mandatory.unwrap_or(false),
        group.is_device_mandatory.unwrap_or(false),
    ))
}

pub fn validate(
    group: &signal_group::Model,
    item: &InboxSubmitItem,
) -> anyhow::Result<()> {
    let mut errors = BTreeMap::new();
    if group.is_sigint_unit_mandatory.unwrap_or(false)
        && item.unit.as_deref().unwrap_or_default().trim().is_empty()
    {
        errors.insert("unit".to_string(), "Оберіть підрозділ.".to_string());
    }
    if group.is_device_mandatory.unwrap_or(false)
        && item.device_name_id.is_none()
    {
        errors.insert(
            "deviceName".to_string(),
            "Вкажіть назву пристрою.".to_string(),
        );
    }
    if !errors.is_empty() {
        return Err(AppError::Form(errors)).c(h!());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
