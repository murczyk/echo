use crate::config::ORGANISM_GOI_ASSOCIATION_WORKER_SLEEP_MS;
use crate::entities::{goi_association, organism};
use crate::error::AppError;
use crate::organism::goi::shared::{
    goi_api_host, goi_api_port, organism_has_goi_api_config,
};
use crate::types::*;
use goi_echo_worker::api::{AssociationApiItem, ListAssociationsReq};
use sea_orm::sea_query::OnConflict;
use sea_orm::*;
use std::time::Duration;
use url::Url;

pub async fn goi_association_worker_nofail(env: Arc<Env>) {
    loop {
        if let Err(err) = goi_association_worker_step(&env).await {
            log::warn!("GOI association worker step failed: {err:#}");
            tokio::time::sleep(goi_worker_sleep_duration()).await;
        }
    }
}

async fn goi_association_worker_step(env: &Env) -> Result<(), AppError> {
    let organisms = load_goi_api_organisms(&env.dbx).await.c(h!())?;
    if organisms.is_empty() {
        tokio::time::sleep(goi_worker_sleep_duration()).await;
        return Ok(());
    }

    for organism in organisms {
        if let Err(err) = sync_goi_associations(env, &organism).await {
            let label = organism.name.clone();
            log::warn!("Skipping GOI association sync for {label}: {err:#}");
        }
        tokio::time::sleep(goi_worker_sleep_duration()).await;
    }
    Ok(())
}

async fn load_goi_api_organisms(
    db: &DatabaseConnection,
) -> Result<Vec<organism::Model>, AppError> {
    let has_api_host = Condition::all()
        .add(organism::Column::GoiApiHost.is_not_null())
        .add(organism::Column::GoiApiHost.ne(""));
    let has_ssh_host = Condition::all()
        .add(organism::Column::GoiSshHost.is_not_null())
        .add(organism::Column::GoiSshHost.ne(""));
    let has_api_login = Condition::all()
        .add(organism::Column::GoiApiLogin.is_not_null())
        .add(organism::Column::GoiApiLogin.ne(""));
    let has_api_password = Condition::all()
        .add(organism::Column::GoiApiPassword.is_not_null())
        .add(organism::Column::GoiApiPassword.ne(""));
    let organisms = organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(Condition::any().add(has_api_host).add(has_ssh_host))
        .filter(has_api_login)
        .filter(has_api_password)
        .all(db)
        .await
        .c(h!())?;
    Ok(organisms
        .into_iter()
        .filter(organism_has_goi_api_config)
        .collect())
}

async fn sync_goi_associations(
    env: &Env,
    organism: &organism::Model,
) -> Result<(), AppError> {
    let since_id = last_source_association_id(&env.dbx, organism.id)
        .await
        .c(h!())?;
    let items = fetch_goi_associations(env, organism, since_id)
        .await
        .c(h!())?;
    if items.is_empty() {
        return Ok(());
    }
    insert_goi_associations(&env.dbx, organism.id, items)
        .await
        .c(h!())?;
    Ok(())
}

async fn last_source_association_id(
    db: &DatabaseConnection,
    organism_id: i64,
) -> Result<Option<i64>, AppError> {
    Ok(goi_association::Entity::find()
        .filter(goi_association::Column::OrganismId.eq(organism_id))
        .order_by_desc(goi_association::Column::SourceAssociationId)
        .one(db)
        .await
        .c(h!())?
        .map(|association| association.source_association_id))
}

async fn fetch_goi_associations(
    env: &Env,
    organism: &organism::Model,
    since_id: Option<i64>,
) -> Result<Vec<AssociationApiItem>, AppError> {
    let url = goi_associations_url(organism)?;
    let login = crate::utils::string::normalize_optional_trimmed(
        organism.goi_api_login.clone(),
    )
    .ok_or_else(|| AppError::BL {
        msg: format!("GOI API login is missing for organism {}", organism.id),
    })?;
    let password = crate::utils::string::normalize_optional_trimmed(
        organism.goi_api_password.clone(),
    )
    .ok_or_else(|| AppError::BL {
        msg: format!(
            "GOI API password is missing for organism {}",
            organism.id
        ),
    })?;

    let response = env
        .rq
        .post(url)
        .basic_auth(login, Some(password))
        .json(&ListAssociationsReq {
            since_id_nonincl: since_id,
        })
        .send()
        .await
        .c(h!())?
        .error_for_status()
        .c(h!())?;
    Ok(response.json::<Vec<AssociationApiItem>>().await.c(h!())?)
}

fn goi_associations_url(
    organism: &organism::Model,
) -> Result<String, AppError> {
    let host = goi_api_host(organism).ok_or_else(|| AppError::BL {
        msg: format!("GOI API host is missing for organism {}", organism.id),
    })?;
    let port = goi_api_port(organism);
    let mut url = if host.starts_with("http://") || host.starts_with("https://")
    {
        Url::parse(&host).c(h!())?
    } else {
        Url::parse(&format!("http://{host}")).c(h!())?
    };
    if url.port().is_none() {
        url.set_port(Some(port as u16)).map_err(|_| AppError::BL {
            msg: format!("invalid GOI API port: {port}"),
        })?;
    }
    url.set_path("/api/associations");
    url.set_query(None);
    Ok(url.to_string())
}

async fn insert_goi_associations(
    db: &DatabaseConnection,
    organism_id: i64,
    items: Vec<AssociationApiItem>,
) -> Result<(), AppError> {
    let associations = items
        .into_iter()
        .map(|item| goi_association_active_model(organism_id, item))
        .collect::<Result<Vec<_>, _>>()?;
    if associations.is_empty() {
        return Ok(());
    }

    goi_association::Entity::insert_many(associations)
        .on_conflict(
            OnConflict::columns([
                goi_association::Column::OrganismId,
                goi_association::Column::SourceAssociationId,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec(db)
        .await
        .c(h!())?;
    Ok(())
}

fn goi_association_active_model(
    organism_id: i64,
    item: AssociationApiItem,
) -> Result<goi_association::ActiveModel, AppError> {
    let row_json = serde_json::to_value(&item.row).c(h!())?;
    let source_created_at = item.created_at.fixed_offset();
    let source_created_at_ms = item.created_at.timestamp_millis();
    let source_date = item.row.source_date().map(|date| date.fixed_offset());
    let goi_echo_worker::row::AssociationRow {
        sheet_name: _,
        row_num: _,
        cells: _,
        association_type,
        frequency,
        coordinates,
        note,
        category,
        call_signs,
        formation,
        association_count,
        sidc,
        author,
        source_date_raw,
        palettes,
    } = item.row;
    let call_signs = serde_json::to_value(call_signs).c(h!())?;
    Ok(goi_association::ActiveModel {
        id: NotSet,
        organism_id: Set(organism_id),
        source_association_id: Set(item.id),
        source_created_at: Set(source_created_at),
        row: Set(row_json),
        created_at: NotSet,
        deleted: Set(item.deleted),
        association_type: Set(association_type),
        frequency: Set(frequency),
        coordinates: Set(coordinates),
        note: Set(note),
        category: Set(category),
        call_signs: Set(call_signs),
        formation: Set(formation),
        association_count: Set(association_count),
        sidc: Set(sidc),
        author: Set(author),
        source_date_raw: Set(source_date_raw),
        source_date: Set(source_date),
        source_created_at_ms: Set(Some(source_created_at_ms)),
        palettes: Set(palettes),
    })
}

fn goi_worker_sleep_duration() -> Duration {
    Duration::from_millis(ORGANISM_GOI_ASSOCIATION_WORKER_SLEEP_MS)
}
