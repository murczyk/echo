use crate::entities::*;
use crate::sigint::area_of_responsibility::render_aor;
use crate::sigint::area_of_responsibility::types::AreaOfResponsibility;
use crate::types::*;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter};
use std::collections::BTreeMap;

pub async fn collect_group_aors<'a, 'async_trait, C>(
    keys: Vec<String>,
    txn: &'a C,
) -> Result<BTreeMap<String, Vec<AreaOfResponsibility>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut result = BTreeMap::new();
    let aors = area_of_responsibility::Entity::find()
        .find_with_related(signal_group_aor::Entity)
        .filter(signal_group_aor::Column::MasterKey.is_in(keys.clone()))
        .all(txn)
        .await
        .context(h!())?;
    for (aor, signal_aors) in aors {
        for signal_aor in signal_aors.into_iter() {
            let aor = render_aor(aor.clone());
            result
                .entry(signal_aor.master_key)
                .or_insert_with(Vec::new)
                .push(aor);
        }
    }
    Ok(result)
}
