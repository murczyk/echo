use crate::entities::sigint_signal_changelog;
use crate::entities::*;
use crate::h;
use crate::sigint::import::types::ImportType;
use anyhow::Context;
use sea_orm::*;
use std::collections::BTreeMap;

pub(crate) async fn find_existing_modulations<'a, 'async_trait, C>(
    txn: &C,
    origin_id: i64,
    import_type: &ImportType,
    recs: &Vec<modulation::Model>,
) -> anyhow::Result<BTreeMap<i64, i64>>
where
    C: ConnectionTrait + 'async_trait,
{
    let existing_record_ids = match import_type {
        ImportType::FromMothership => {
            let ids = recs
                .iter()
                .flat_map(|rec| rec.mothership_id)
                .collect::<Vec<_>>();
            if ids.is_empty() {
                BTreeMap::new()
            } else {
                sigint_signal_changelog::Entity::find()
                    .filter(
                        sigint_signal_changelog::Column::MothershipId
                            .is_in(ids),
                    )
                    .all(txn)
                    .await
                    .context(h!())?
                    .into_iter()
                    .flat_map(|rec| {
                        rec.mothership_id.clone().map(|id| (id, rec.id))
                    })
                    .collect()
            }
        }
        ImportType::ToMothership => {
            let ids = recs
                .iter()
                .flat_map(|rec| rec.original_id)
                .collect::<Vec<_>>();
            if ids.is_empty() {
                BTreeMap::new()
            } else {
                sigint_signal_changelog::Entity::find()
                    .filter(
                        sigint_signal_changelog::Column::OriginalId
                            .is_in(ids)
                            .and(
                                sigint_signal_changelog::Column::SigintOriginId
                                    .eq(origin_id),
                            ),
                    )
                    .all(txn)
                    .await
                    .context(h!())?
                    .into_iter()
                    .flat_map(|rec| {
                        rec.original_id.clone().map(|id| (id, rec.id))
                    })
                    .collect()
            }
        }
    };
    Ok(existing_record_ids)
}
