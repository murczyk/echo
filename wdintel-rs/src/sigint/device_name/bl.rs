use super::query;
use super::types::{
    CreateDeviceNameReq, CreateDeviceNameRsp, DeviceNameResolveReq,
    DeviceNameResolveRsp, DeviceNameSearchReq, DeviceNameSearchResult,
    DeviceNameSearchRsp,
};
use crate::config::DEVICE_NAME_RESOLVE_LIMIT;
use crate::error::AppError;
use crate::types::*;
use sea_orm::ConnectionTrait;
use std::collections::HashSet;

pub async fn create_device_name<C>(
    dbx: &C,
    login: uuid::Uuid,
    req: CreateDeviceNameReq,
) -> Result<CreateDeviceNameRsp, AppError>
where
    C: ConnectionTrait,
{
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BL {
            msg: "device name cannot be empty".to_string(),
        });
    }

    if let Some(device) = query::find_by_exact_name(dbx, &name).await.c(h!())? {
        return Ok(CreateDeviceNameRsp {
            device: render_device_name(device).c(h!())?,
        });
    }

    let device = query::create(dbx, login, name).await.c(h!())?;

    Ok(CreateDeviceNameRsp {
        device: render_device_name(device).c(h!())?,
    })
}

pub async fn search_device_names<C>(
    dbx: &C,
    req: DeviceNameSearchReq,
) -> Result<DeviceNameSearchRsp, AppError>
where
    C: ConnectionTrait,
{
    let search_phrase = req.search.trim();

    let devices = query::search(dbx, search_phrase)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|device| {
            device.name.map(|name| DeviceNameSearchResult {
                id: device.id,
                name,
            })
        })
        .collect();

    Ok(DeviceNameSearchRsp { devices })
}

pub async fn resolve_device_names<C>(
    dbx: &C,
    req: DeviceNameResolveReq,
) -> Result<DeviceNameResolveRsp, AppError>
where
    C: ConnectionTrait,
{
    let names = normalize_device_name_batch(req.names).c(h!())?;
    let devices = query::find_by_exact_names(dbx, &names)
        .await
        .c(h!())?
        .into_iter()
        .map(render_device_name)
        .collect::<Result<Vec<_>, _>>()
        .c(h!())?;
    Ok(DeviceNameResolveRsp { devices })
}

fn normalize_device_name(name: &str) -> Option<String> {
    let name = name.trim().to_lowercase();
    (!name.is_empty()).then_some(name)
}

fn normalize_device_name_batch(
    names: Vec<String>,
) -> Result<Vec<String>, AppError> {
    if names.len() > DEVICE_NAME_RESOLVE_LIMIT {
        return Err(AppError::BL {
            msg: format!("at most {DEVICE_NAME_RESOLVE_LIMIT} device names can be resolved"),
        });
    }
    let mut seen = HashSet::new();
    Ok(names
        .into_iter()
        .filter_map(|name| normalize_device_name(&name))
        .filter(|name| seen.insert(name.clone()))
        .collect())
}

fn render_device_name(
    device: query::DeviceNameRow,
) -> Result<DeviceNameSearchResult, AppError> {
    Ok(DeviceNameSearchResult {
        id: device.id,
        name: device.name.ok_or_else(|| AppError::BL {
            msg: format!("device name #{} has empty name", device.id),
        })?,
    })
}

#[cfg(test)]
mod tests {
    use super::{normalize_device_name, normalize_device_name_batch};
    use crate::config::DEVICE_NAME_RESOLVE_LIMIT;
    use crate::error::AppError;

    #[test]
    fn device_name_resolution_normalizes_and_deduplicates_in_request_order() {
        assert_eq!(
            normalize_device_name("  ПриСТРІЙ  "),
            Some("пристрій".to_string())
        );
        assert_eq!(normalize_device_name("  "), None);
        assert_eq!(
            normalize_device_name_batch(vec![
                " Device-A ".to_string(),
                "device-a".to_string(),
                "ПриСТРІЙ".to_string(),
                "пристрій".to_string(),
                "".to_string(),
                "Device-B".to_string(),
            ])
            .unwrap(),
            vec![
                "device-a".to_string(),
                "пристрій".to_string(),
                "device-b".to_string(),
            ],
        );
    }

    #[test]
    fn device_name_resolution_rejects_oversized_raw_batches_before_normalizing()
    {
        let allowed = vec![" Device ".to_string(); DEVICE_NAME_RESOLVE_LIMIT];
        assert_eq!(
            normalize_device_name_batch(allowed).unwrap(),
            vec!["device".to_string()]
        );

        let error = normalize_device_name_batch(vec![
            " ".to_string();
            DEVICE_NAME_RESOLVE_LIMIT
                + 1
        ])
        .unwrap_err();
        assert!(matches!(error, AppError::BL { .. }));
    }
}
