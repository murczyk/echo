use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use crate::utils::string::master_key_shortcut;
use sea_orm::*;

pub async fn oneoff_print_organism_groups(
    mode: Mode,
    ps: &crate::OneoffPrintOrganismGroupsPs,
) -> Result<(), AppError> {
    info!("starting oneoff_print_organism_groups...");
    let config = crate::config::read_config(mode).context(h!())?;
    let db = crate::new_pg_pool_from_config(&config)
        .await
        .context(h!())?;
    let organism_name = ps.organism_name.clone();
    let organism = organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(organism::Column::Name.eq(organism_name))
        .one(&db)
        .await
        .context(h!())?
        .context(h!())?;

    let organism_groups =
        crate::organism::load_organism_group_ids(&db, organism.id)
            .await
            .context(h!())?;
    let available_keys = organism_groups.available_keys;
    info!("Available groups: {}", available_keys.len());
    for available_key in available_keys {
        let group = signal_group::Entity::find()
            .filter(signal_group::Column::MasterKey.eq(available_key.clone()))
            .one(&db)
            .await
            .context(h!())?
            .context(available_key.clone())?;
        let master_key_short = master_key_shortcut(group.master_key.as_str());
        info!(
            "- {} master_key={}",
            group.name.unwrap_or("<None>".to_string()),
            master_key_short
        );
    }

    Ok(())
}
