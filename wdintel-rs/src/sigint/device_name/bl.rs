use super::query;
use super::types::{
    CreateDeviceNameReq, CreateDeviceNameRsp, DeviceNameSearchReq,
    DeviceNameSearchResult, DeviceNameSearchRsp,
};
use crate::error::AppError;
use crate::types::*;
use sea_orm::ConnectionTrait;

pub async fn create_device_name<C>(
    dbx: &C,
    login: String,
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
    if search_phrase.is_empty() {
        return Ok(DeviceNameSearchRsp { devices: vec![] });
    }

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
