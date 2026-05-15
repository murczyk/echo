use crate::entities::*;
use crate::error::AppError;
use crate::sigint::aor::load_default_aor;
use crate::types::*;
use crate::utils::string::master_key_shortcut;
use sea_orm::*;

pub async fn oneoff_print_organism_groups(
    mode: Mode,
    ps: &crate::OneoffPrintOrganismGroupsPs,
) -> Result<(), AppError> {
    info!("starting oneoff_print_organism_groups...");
    let config = crate::config::read_config(mode).c(h!())?;
    let db = crate::new_pg_pool_from_config(&config).await.c(h!())?;
    let organism_name = ps.organism_name.clone();
    info!(
        "Determining organism name for organism: {:#?}",
        organism_name
    );
    let organism = organism::Entity::find()
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(organism::Column::Name.eq(organism_name))
        .one(&db)
        .await
        .c(h!())?
        .c(h!())?;

    let organism_groups =
        crate::organism::load_organism_group_ids(&db, organism.id)
            .await
            .c(h!())?;
    let available_keys = organism_groups.available_keys;
    info!("Available groups: {}", available_keys.len());
    for available_key in available_keys {
        let group = signal_group::Entity::find()
            .filter(signal_group::Column::Deleted.eq(false))
            .filter(signal_group::Column::MasterKey.eq(available_key.clone()))
            .one(&db)
            .await
            .c(h!())?
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

pub async fn oneoff_fix_organism_aors(
    dbx: &DatabaseConnection,
) -> anyhow::Result<()> {
    let organisms_without_aors = organism::Entity::find()
        .join(JoinType::LeftJoin, organism::Relation::OrganismAor.def())
        .filter(organism::Column::DeletedPermanently.eq(false))
        .filter(organism::Column::Enabled.eq(true))
        .filter(organism_aor::Column::Id.is_null())
        .all(dbx)
        .await
        .c(h!())?;
    if organisms_without_aors.is_empty() {
        return Ok(());
    };
    let default_aor = load_default_aor(dbx).await.c(h!())?;
    for o in organisms_without_aors {
        organism_aor::ActiveModel {
            id: NotSet,
            organism_id: Set(o.id),
            aor_id: Set(default_aor.id),
            created_at: NotSet,
        }
        .insert(dbx)
        .await
        .c(h!())?;
    }
    Ok(())
}
