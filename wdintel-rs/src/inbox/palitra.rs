use crate::entities::*;
use crate::palitra::types::PalitraAccess;
use crate::rer_importer::body_noheader::NoHeadersBody;
use crate::types::*;
use crate::utils::orm::ArrayColumnOps;
use sea_orm::*;

pub async fn add_message_point_tokens<'async_trait, C>(
    txn: &C,
    rq: &reqwest::Client,
    message_id: i64,
    body_noheader: &NoHeadersBody,
    network_ids: Vec<i64>,
    group_aor_ids: Vec<i64>,
) -> Result<(), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let network_aor_ids = resolve_aor_ids_by_networks(txn, network_ids)
        .await
        .context(h!())?;
    let palitra_aor_ids = if !network_aor_ids.is_empty() {
        network_aor_ids
    } else {
        group_aor_ids
    };

    let palitra_point_lexemes = if !palitra_aor_ids.is_empty() {
        let access = PalitraAccess::ByAor {
            aor_ids: palitra_aor_ids,
        };
        crate::rer_importer::points::load_relevant_palitra_point_lexemes(
            txn, access, false,
        )
        .await
        .context(h!())?
    } else {
        Default::default()
    };
    let message_palitra_highlights =
        crate::rer_importer::points::highlight_points(
            rq,
            &body_noheader.body,
            &palitra_point_lexemes,
            body_noheader.start,
        )
        .await
        .c(h!())?;

    let inbox_item_point_tokens: Vec<_> = message_palitra_highlights
        .iter()
        .map(|highlight| {
            let point_tokens = serde_json::json!(&highlight.points);
            sigint_inbox_item_point_token::ActiveModel {
                palitra_id: Set(highlight.palitra_id),
                point_tokens: Set(point_tokens),
                sigint_inbox_item_id: Set(message_id),
                ..Default::default()
            }
        })
        .collect();
    if !inbox_item_point_tokens.is_empty() {
        sigint_inbox_item_point_token::Entity::insert_many(
            inbox_item_point_tokens,
        )
        .on_conflict(
            sea_query::OnConflict::columns([
                sigint_inbox_item_point_token::Column::SigintInboxItemId,
                sigint_inbox_item_point_token::Column::PalitraId,
            ])
            .do_nothing()
            .to_owned(),
        )
        .exec_without_returning(txn)
        .await
        .c(h!())?;
    }

    Ok(())
}

pub async fn resolve_aor_ids_by_networks<'a, 'async_trait, C>(
    txn: &'a C,
    network_ids: Vec<i64>,
) -> Result<Vec<i64>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if network_ids.is_empty() {
        return Ok(vec![]);
    };
    let m_aor_ids = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.eq_any(network_ids))
        .filter(sigint_network::Column::Deleted.eq(false))
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkAor.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_aor::Relation::AreaOfResponsibility.def(),
        )
        .filter(area_of_responsibility::Column::Deleted.eq(false))
        .select_only()
        .column(area_of_responsibility::Column::Id)
        .into_tuple::<i64>()
        .all(txn)
        .await
        .c(h!())?;
    Ok(m_aor_ids)
}
