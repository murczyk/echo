use crate::config::SIGINT_UNIT_HEADER_SYNONYMS_REFRESH_SECS;
use crate::entities::{sigint_unit, sigint_unit_label};
use crate::h;
use crate::inbox::unit_resolution::normalize_unit_label;
use crate::types::ShortContext;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, JoinType, QueryFilter,
    QuerySelect, RelationTrait,
};
use std::collections::HashMap;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::time::Instant;

#[derive(Default)]
pub(crate) struct UnitHeaderSynonyms {
    snapshot: RwLock<Option<SynonymSnapshot>>,
}

struct SynonymSnapshot {
    loaded_at: Instant,
    names: HashMap<String, HeaderSynonymUnit>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HeaderSynonymUnit {
    pub(crate) id: i64,
    pub(crate) name: String,
}

impl SynonymSnapshot {
    fn is_expired(&self) -> bool {
        self.loaded_at.elapsed()
            >= Duration::from_secs(SIGINT_UNIT_HEADER_SYNONYMS_REFRESH_SECS)
    }
}

impl UnitHeaderSynonyms {
    pub(crate) async fn resolve<C>(
        &self,
        db: &C,
        body: &str,
    ) -> anyhow::Result<Option<HeaderSynonymUnit>>
    where
        C: ConnectionTrait,
    {
        let Some(header) =
            body.lines().map(str::trim).find(|line| !line.is_empty())
        else {
            return Ok(None);
        };
        let header = normalize_unit_label(header);
        let snapshot = self.snapshot.read().await;
        if let Some(snapshot) = snapshot.as_ref() {
            if !snapshot.is_expired() {
                return Ok(snapshot.names.get(&header).cloned());
            }
        }
        drop(snapshot);

        let mut snapshot = self.snapshot.write().await;
        if snapshot.as_ref().is_none_or(SynonymSnapshot::is_expired) {
            let names = load_names(db).await.c(h!())?;
            *snapshot = Some(SynonymSnapshot {
                loaded_at: Instant::now(),
                names,
            });
        }
        Ok(snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.names.get(&header).cloned()))
    }
}

async fn load_names<C>(
    db: &C,
) -> anyhow::Result<HashMap<String, HeaderSynonymUnit>>
where
    C: ConnectionTrait,
{
    let names = sigint_unit_label::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit_label::Relation::SigintUnit.def(),
        )
        .filter(sigint_unit::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_unit_label::Column::Label)
        .column(sigint_unit::Column::Id)
        .column(sigint_unit::Column::Name)
        .into_tuple::<(String, i64, String)>()
        .all(db)
        .await
        .c(h!())?;
    Ok(names
        .into_iter()
        .map(|(label, id, name)| {
            (normalize_unit_label(&label), HeaderSynonymUnit { id, name })
        })
        .collect())
}
