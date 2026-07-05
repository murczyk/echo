use super::query;
use super::types::{
    ComputerNameSearchReq, ComputerNameSearchResult, ComputerNameSearchRsp,
    CreateComputerNameReq, CreateComputerNameRsp,
};
use crate::entities::computer_name;
use crate::error::AppError;
use crate::types::*;
use sea_orm::ConnectionTrait;

pub async fn create_computer_name<C>(
    dbx: &C,
    login: String,
    req: CreateComputerNameReq,
) -> Result<CreateComputerNameRsp, AppError>
where
    C: ConnectionTrait,
{
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::BL {
            msg: "computer name cannot be empty".to_string(),
        });
    }

    if let Some(computer) =
        query::find_by_exact_name(dbx, &name).await.c(h!())?
    {
        return Ok(CreateComputerNameRsp {
            computer: render_computer_name(computer).c(h!())?,
        });
    }

    let computer = query::create(dbx, login, name).await.c(h!())?;

    Ok(CreateComputerNameRsp {
        computer: render_computer_name(computer).c(h!())?,
    })
}

pub async fn search_computer_names<C>(
    dbx: &C,
    req: ComputerNameSearchReq,
) -> Result<ComputerNameSearchRsp, AppError>
where
    C: ConnectionTrait,
{
    let search_phrase = req.search.trim();
    if search_phrase.is_empty() {
        return Ok(ComputerNameSearchRsp { computers: vec![] });
    }

    let computers = query::search(dbx, search_phrase)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|computer| {
            computer.name.map(|name| ComputerNameSearchResult {
                id: computer.id,
                name,
            })
        })
        .collect();

    Ok(ComputerNameSearchRsp { computers })
}

fn render_computer_name(
    computer: computer_name::Model,
) -> Result<ComputerNameSearchResult, AppError> {
    Ok(ComputerNameSearchResult {
        id: computer.id,
        name: computer.name.ok_or_else(|| AppError::BL {
            msg: format!("computer name #{} has empty name", computer.id),
        })?,
    })
}
