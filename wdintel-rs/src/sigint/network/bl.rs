use super::sea_orm_active_enums::*;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::types::{InboxMapItem, MapPointsFilter};
use crate::sigint::network::types::*;
use crate::types::*;
use crate::utils::*;
use chrono::*;
use itertools::Itertools;
use sea_orm::sea_query::*;
use sea_orm::*;
use std::collections::{BTreeSet, HashMap};

use actix_web::web::Json;
use log::*;
use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QuerySelect,
    Statement,
};
use sea_query::{
    Alias, CommonTableExpression, Expr as SeaExpr, PostgresQueryBuilder, Query,
};

pub async fn render_networks<'a, 'async_trait, C>(
    networks: Vec<sigint_network::Model>,
    txn: &'a C,
) -> Result<Vec<Network>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let instant = std::time::Instant::now();

    if networks.is_empty() {
        return Ok(vec![]);
    }

    // collect all ids first
    let network_ids: Vec<i64> = networks.iter().map(|n| n.id).collect();

    // fetch all related data in bulk
    let freqs_map =
        get_networks_freqs(txn, &network_ids).await.context(h!())?;
    let units_map =
        get_networks_units(txn, &network_ids).await.context(h!())?;
    let posts_map =
        get_networks_posts(txn, &network_ids).await.context(h!())?;
    let descs_map = get_networks_descriptions(txn, &network_ids)
        .await
        .context(h!())?;
    let aors_map = get_networks_aor_ids(txn, &network_ids)
        .await
        .context(h!())?;

    let mut networks_res = Vec::with_capacity(networks.len());
    for network in &networks {
        networks_res.push(Network {
            id: network.id,
            freqs: freqs_map.get(&network.id).cloned().unwrap_or_default(),
            unit_ids: units_map.get(&network.id).cloned(),
            post_ids: posts_map.get(&network.id).cloned().unwrap_or_default(),
            descriptions: descs_map
                .get(&network.id)
                .cloned()
                .unwrap_or_default(),
            aor_ids: aors_map.get(&network.id).cloned().unwrap_or_default(),
            name: network.name.clone(),
            location: network.location.clone(),
            radio_station: network.radio_station.clone(),
            created_at: network.created_at.and_utc().timestamp_millis(),
            purpose: network.purpose.clone(),
            operation_mode: network.operation_mode.clone(),
            operation_type: network.operation_type.clone(),
            operation_period: network.operation_period.clone(),
            last_updated_at: network.updated_at.and_utc().timestamp_millis(),
            last_updated_by: network.updated_by.clone(),
            active_from: network
                .active_from
                .map(|d| d.and_utc().timestamp_millis()),
            active_to: network
                .active_to
                .map(|d| d.and_utc().timestamp_millis()),
            deleted: network.deleted,
        });
    }
    trace!(
        "> render_networks execution time for {} networks is: {:?}",
        &networks.len(),
        instant.elapsed()
    );
    Ok(networks_res)
}

async fn get_networks_freqs<'a, 'async_trait, C>(
    txn: &'a C,
    network_ids: &[i64],
) -> Result<HashMap<i64, Vec<NetworkFreq>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if network_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let freqs = sigint_network_freq::Entity::find()
        .filter(
            sigint_network_freq::Column::NetworkId.is_in(network_ids.to_vec()),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .all(txn)
        .await
        .context(h!())?;

    let mut freq_map: HashMap<i64, Vec<NetworkFreq>> = HashMap::new();

    for freq in freqs {
        freq_map
            .entry(freq.network_id)
            .or_default()
            .push(NetworkFreq {
                id: freq.id,
                network_id: freq.network_id,
                freq: freq.freq.clone(),
                deleted: freq.deleted,
                active_to: freq
                    .active_to
                    .map(|d| d.and_utc().timestamp_millis()),
                active_from: freq.active_from.and_utc().timestamp_millis(),
                created_at: freq.created_at.and_utc().timestamp_millis(),
                kind: freq.kind.to_value(),
                modulation_id: freq.modulation_id,
            });
    }

    Ok(freq_map)
}

pub async fn get_networks_units<'a, 'async_trait, C>(
    txn: &'a C,
    network_ids: &[i64],
) -> Result<HashMap<i64, Vec<i64>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if network_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let network_units = sigint_network_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintUnit.def(),
        )
        .filter(
            sigint_network_unit::Column::NetworkId.is_in(network_ids.to_vec()),
        )
        .filter(sigint_unit::Column::Deleted.eq(false))
        .all(txn)
        .await
        .context(h!())?;

    let mut unit_map: HashMap<i64, Vec<i64>> = HashMap::new();

    for unit in network_units {
        unit_map
            .entry(unit.network_id)
            .or_default()
            .push(unit.unit_id);
    }

    Ok(unit_map)
}

async fn get_networks_posts<'a, 'async_trait, C>(
    txn: &'a C,
    network_ids: &[i64],
) -> Result<HashMap<i64, Vec<i64>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if network_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let network_posts = sigint_network_post::Entity::find()
        .filter(
            sigint_network_post::Column::NetworkId.is_in(network_ids.to_vec()),
        )
        .filter(sigint_network_post::Column::Deleted.eq(false))
        .all(txn)
        .await
        .context(h!())?;

    let mut post_map: HashMap<i64, Vec<i64>> = HashMap::new();

    for post in network_posts {
        post_map
            .entry(post.network_id)
            .or_default()
            .push(post.post_id);
    }

    Ok(post_map)
}

async fn get_networks_aor_ids<'a, 'async_trait, C>(
    txn: &'a C,
    network_ids: &[i64],
) -> Result<HashMap<i64, Vec<i64>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if network_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let network_aors = sigint_network_aor::Entity::find()
        .filter(
            sigint_network_aor::Column::NetworkId.is_in(network_ids.to_vec()),
        )
        .all(txn)
        .await
        .context(h!())?;

    let mut aor_map: HashMap<i64, Vec<i64>> = HashMap::new();

    for net_aor in network_aors {
        aor_map
            .entry(net_aor.network_id)
            .or_default()
            .push(net_aor.aor_id);
    }

    Ok(aor_map)
}

pub async fn get_networks_descriptions<'a, 'async_trait, C>(
    txn: &'a C,
    network_ids: &[i64],
) -> Result<HashMap<i64, Vec<NetworkDescription>>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if network_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let network_descriptions = sigint_network_description::Entity::find()
        .filter(
            sigint_network_description::Column::NetworkId
                .is_in(network_ids.to_vec()),
        )
        .filter(sigint_network_description::Column::Deleted.eq(false))
        .order_by_asc(sigint_network_description::Column::Type)
        .order_by_asc(sigint_network_description::Column::CreatedAt)
        .all(txn)
        .await
        .context(h!())?;

    let mut descr_map: HashMap<i64, Vec<NetworkDescription>> = HashMap::new();

    for x in network_descriptions {
        let descr = NetworkDescription {
            id: x.id,
            network_id: x.network_id,
            network_frequency_id: x.sigint_network_freq_id,
            descr_type: NetworkDescrType::from(x.r#type.clone()),
            description: x.description.clone(),
            // comment: x.comment.clone(),
            login: x.login.clone(),
            created_at: x.created_at.and_utc().timestamp_millis(),
        };

        descr_map.entry(x.network_id).or_default().push(descr);
    }

    Ok(descr_map)
}

pub async fn find_network<'a, 'async_trait, C>(
    txn: &'a C,
    network_id: i64,
) -> Result<sigint_network::Model, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let network = sigint_network::Entity::find_by_id(network_id)
        .one(txn)
        .await
        .context(h!())?
        .ok_or_else(|| AppError::NotFound)?;
    Ok(network)
}

pub async fn bl_network_info_freqs(
    freqs: Vec<String>,
    txn: &DatabaseTransaction,
) -> Result<Vec<Network>, AppError> {
    let sel = sigint_network_freq::Entity::find()
        .filter(
            sigint_network_freq::Column::NetworkId
                .into_simple_expr()
                .eq(sigint_network::Column::Id.into_simple_expr()),
        )
        .filter(sigint_network_freq::Column::Freq.is_in(&freqs));

    let networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(Expr::exists(
            sel.select_only()
                .column(sigint_network_freq::Column::Id)
                .into_query(),
        ));
    // .order_by_asc(sigint_network::Column::Freq);

    // println!(
    //     "> bl_network_info_batch sql: {}",
    //     networks_with_modulation.clone().build(DbBackend::Postgres).to_string()
    // );

    let networks = networks.all(txn).await.context(h!())?;
    Ok(render_networks(networks, txn).await.context(h!())?)
}

pub async fn bl_network_info_batch(
    network_ids: Vec<i64>,
    txn: &DatabaseTransaction,
) -> Result<Vec<Network>, AppError> {
    let networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.is_in(network_ids));
    // .order_by_asc(sigint_network::Column::Freq);

    // println!(
    //     "> bl_network_info_batch sql: {}",
    //     networks_with_modulation.clone().build(DbBackend::Postgres).to_string()
    // );

    let networks = networks.all(txn).await.context(h!())?;
    Ok(render_networks(networks, txn).await.context(h!())?)
}

pub async fn network_group_activity_bl(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkGroupsActivityReq>,
) -> Result<HashMap<String, HashMap<String, HashMap<String, i64>>>, AppError> {
    crate::users::has_role(&env.dbx, &user.id()?, "Rer")
        .await
        .context(h!())?;
    let dt_till = if let Some(till) = req.till_date_noninclusive_ms {
        dt_from_millis(till)?
    } else {
        Utc::now().naive_utc()
    };

    let networks_group_stat = signal_message::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
            Alias::new("sigint_inbox_item"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintNetworkFreq.def(),
            Alias::new("sigint_network_freq"),
        )
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
            Alias::new("signal_group"),
        )
        .join_as(
            JoinType::LeftJoin,
            datasource_group::Relation::SignalGroup.def(),
            Alias::new("signal_group"),
        )
        .select_only()
        .column_as(
            Expr::cust(
                "(EXTRACT(EPOCH FROM DATE_TRUNC('day', sigint_inbox_item.datetime AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')) * 1000)::BIGINT",
            ),
            "day",
        )
        .column_as(sigint_network_freq::Column::NetworkId, "network_id")
        .column_as(signal_group::Column::Name, "group")
        .column_as(Expr::cust("count(*)"), "count")
        .group_by(Expr::cust(
            "network_id, day, signal_group.name",
        ))
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(
            datasource_group::Column::GroupMasterKey.is_in(
                crate::users::get_identity_sigint_groups_noimport(
                    &env.dbx,
                    &user,
                    &env.config,
                )
                    .await.context(h!())?,
            ),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.lte(dt_till))
        .filter(Expr::cust_with_values("sigint_inbox_item.datetime >= $1 - INTERVAL '10 days'", vec![dt_till]))
        .filter(sigint_network_freq::Column::NetworkId.is_in(req.network_ids.clone()));

    let networks_group_stat = networks_group_stat
        .clone()
        .order_by_desc(Expr::cust("network_id, day, \"group\""));

    // println!(
    //     "> sql: {}",
    //     networks_group_stat.clone().build(DbBackend::Postgres).to_string()
    // );
    #[derive(FromQueryResult)]
    pub struct NetworkGroupsMessageCountByDay {
        pub network_id: i64,
        pub count: i64,
        pub group: String,
        pub day: i64,
    }

    let mut res = HashMap::new();
    for row in networks_group_stat
        .into_model::<NetworkGroupsMessageCountByDay>()
        .all(&env.dbx)
        .await
        .context(h!())?
    {
        let network_id = row.network_id.to_string();
        let day = row.day.to_string();
        let group = row.group.clone();
        let count = row.count;
        if !res.contains_key(&network_id) {
            res.insert(network_id.clone(), HashMap::new());
        }
        let freq_map = res.get_mut(&network_id).unwrap();
        if !freq_map.contains_key(&day) {
            freq_map.insert(day.clone(), HashMap::new());
        }
        let day_map = freq_map.get_mut(&day).unwrap();
        day_map.insert(group.clone(), count);
    }

    Ok(res)
}

pub async fn collect_network_units(
    inbox_items: &Vec<InboxMapItem>,
    dbx: &DatabaseConnection,
    map_filter: Option<MapPointsFilter>,
) -> anyhow::Result<BTreeMap<String, Vec<sigint_unit::Model>>> {
    let freqs = inbox_items
        .iter()
        .filter_map(|x| x.freq.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec();
    let freq_networks = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
        )
        .filter(sigint_network_freq::Column::Freq.is_in(freqs))
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .select_only()
        .column(sigint_network::Column::Id) //
        .column(sigint_network_freq::Column::Freq) // Select sn::Column
        .into_tuple::<(i64, String)>()
        .all(dbx)
        .await
        .context(h!())?;
    let network_ids = freq_networks.iter().map(|x| x.0).unique().collect_vec();
    let units = sigint_network_unit::Entity::find()
        .find_with_related(sigint_unit::Entity)
        .filter(sigint_network_unit::Column::NetworkId.is_in(network_ids))
        .all(dbx)
        .await
        .context(h!())?;
    let mut network_units_map = BTreeMap::new();
    for (network_unit, units) in units {
        let recs = network_units_map
            .entry(network_unit.network_id)
            .or_insert(vec![]);
        for u in units {
            recs.push(u);
        }
    }

    let data: Option<BTreeSet<String>> = if let Some(map_filter) = map_filter {
        let data = map_filter
            .network_units
            .into_iter()
            .map(|r| r.name)
            .collect::<BTreeSet<_>>();
        Some(data)
    } else {
        None
    };

    fn unit_filter(
        u: &sigint_unit::Model,
        data: &Option<BTreeSet<String>>,
    ) -> bool {
        match data {
            Some(data) => data.contains(&u.name),
            None => true,
        }
    }
    let mut result: BTreeMap<String, Vec<sigint_unit::Model>> = BTreeMap::new();
    for (network_id, freq) in freq_networks {
        let s_units = result.entry(freq).or_default();
        if let Some(units) = network_units_map.get(&network_id) {
            for u in units {
                if unit_filter(u, &data) {
                    s_units.push(u.clone());
                }
            }
        }
    }
    Ok(result)
}

pub async fn load_networks_units_desc(
    network_ids: Vec<i64>,
    dbx: &DatabaseConnection,
    h: &'static str,
) -> anyhow::Result<BTreeMap<i64, Vec<String>>> {
    #[derive(Debug, Clone, FromQueryResult)]
    struct NetworkDesc {
        pub network_id: i64,
        pub unit_name: Option<String>,
    }

    let data: Vec<NetworkDesc> = sigint_unit::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_unit::Relation::SigintNetworkUnit.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network_unit::Relation::SigintNetwork.def(),
        )
        .filter(sigint_network::Column::Id.is_in(network_ids))
        .select_only()
        .column_as(sigint_network_unit::Column::NetworkId, "network_id")
        .column_as(sigint_unit::Column::Name, "unit_name")
        .into_model::<NetworkDesc>()
        .all(dbx)
        .await
        .context(h)?;

    let mut result: BTreeMap<i64, Vec<String>> = BTreeMap::new();
    for rec in data.into_iter() {
        if let Some(name) = rec.unit_name {
            result
                .entry(rec.network_id)
                .or_insert_with(|| Vec::with_capacity(1))
                .push(name)
        };
    }
    Ok(result)
}

pub async fn merge_two_networks(
    txn: &DatabaseTransaction,
    login: String,
    perform_merge_check: bool,
    network_id_from: i64,
    network_id_to: i64,
) -> anyhow::Result<(), AppError> {
    // Fetch both networks
    let network_from =
        find_network(txn, network_id_from).await.context(h!())?;

    let network_to = find_network(txn, network_id_to).await.context(h!())?;

    // Fetch units for both networks
    let unit_from = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id_from))
        .select_only()
        .column(sigint_network_unit::Column::UnitId)
        .into_tuple::<i64>()
        .one(txn)
        .await
        .context(h!())?;

    let unit_to = sigint_network_unit::Entity::find()
        .filter(sigint_network_unit::Column::NetworkId.eq(network_id_to))
        .select_only()
        .column(sigint_network_unit::Column::UnitId)
        .into_tuple::<i64>()
        .one(txn)
        .await
        .context(h!())?;

    if perform_merge_check {
        // Validate if merge is allowed (Names should match)
        if network_from.name != network_to.name {
            return Err(AppError::BL {
                msg: "Networks names or kinds mismatch".to_string(),
            });
        }

        // Ensure they belong to the same unit
        if unit_from != unit_to {
            return Err(AppError::BL {
                msg: "Networks belong to different units".to_string(),
            });
        }
    }

    // Reassign frequencies to the new network
    let freqs_to = sigint_network_freq::Entity::find()
        .select_only()
        .column(sigint_network_freq::Column::Freq)
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_to))
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .into_query();

    let freqs_from = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_from))
        .filter(sigint_network_freq::Column::ActiveTo.is_null())
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network_freq::Column::Freq.not_in_subquery(freqs_to))
        .all(txn)
        .await
        .context(h!())?;

    for freq in freqs_from {
        let id = freq.id;
        let json_old = sigint_network_freq::Entity::find_by_id(id)
            .into_json()
            .one(txn)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;

        let mut freq_model = freq.into_active_model();
        freq_model.network_id = Set(network_id_to);
        freq_model.update(txn).await.context(h!())?;

        // Log the change of an old dentork in the changelog
        let json_new = sigint_network_freq::Entity::find_by_id(id)
            .into_json()
            .one(txn)
            .await
            .context(h!())?
            .ok_or(AppError::NotFound)?;
        sigint_network_freq_changelog::ActiveModel {
            id: NotSet,
            sigint_network_freq_id: Set(id),
            login: Set(login.clone()),
            action: Set(ChangelogActionEnum::Merge),
            created_at: NotSet,
            new_value: Set(Some(json_new)),
            old_value: Set(Some(json_old)),
            req: Set(None),
            sigint_origin_id: NotSet,
            original_id: NotSet,
        }
        .insert(txn)
        .await
        .context(h!())?;
    }

    // Reassign posts to the new network
    let posts_to = sigint_network_post::Entity::find()
        .select_only()
        .column(sigint_network_post::Column::Id)
        .filter(sigint_network_post::Column::NetworkId.eq(network_id_to))
        .filter(sigint_network_post::Column::Deleted.eq(false))
        .into_query();

    let posts_from = sigint_network_post::Entity::find()
        .filter(sigint_network_post::Column::NetworkId.eq(network_id_from))
        .filter(sigint_network_post::Column::Deleted.eq(false))
        .filter(sigint_network_post::Column::Id.not_in_subquery(posts_to))
        .all(txn)
        .await
        .context(h!())?;

    for post in posts_from {
        let mut post_model = post.into_active_model();
        post_model.network_id = Set(network_id_to);
        post_model.update(txn).await.context(h!())?;
    }

    // Reassign descriptions to the new network
    let descriptions_from = sigint_network_description::Entity::find()
        .filter(
            sigint_network_description::Column::NetworkId.eq(network_id_from),
        )
        .filter(sigint_network_description::Column::Deleted.eq(false))
        .all(txn)
        .await
        .context(h!())?;

    for description in descriptions_from {
        let mut descr_model = description.into_active_model();
        descr_model.network_id = Set(network_id_to);
        descr_model.update(txn).await.context(h!())?;
    }

    // Delete all remaining descriptions in the source network (those not reassigned)
    sigint_network_description::Entity::delete_many()
        .filter(
            sigint_network_description::Column::NetworkId.eq(network_id_from),
        )
        .exec(txn)
        .await
        .context(h!())?;

    // Delete all remaining posts in the source network (those not reassigned)
    sigint_network_post::Entity::delete_many()
        .filter(sigint_network_post::Column::NetworkId.eq(network_id_from))
        .exec(txn)
        .await
        .context(h!())?;

    // Delete all remaining freqs in the source network (those not reassigned)
    sigint_network_freq::Entity::delete_many()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_from))
        .exec(txn)
        .await
        .context(h!())?;

    // Update network_to attributes by concatenating only unique values
    let new_location = concat_unique(
        Some(network_to.location.clone()),
        Some(network_from.location.clone()),
    );
    let new_radio_station = concat_unique(
        network_to.radio_station.clone(),
        network_from.radio_station.clone(),
    );

    // Get updated network activity range for the new network
    let (network_active_from, network_active_to) =
        get_network_activity_range(txn, network_id_to)
            .await
            .context(h!())?;

    let mut network_to_model: sigint_network::ActiveModel = network_to.into();
    network_to_model.location = Set(new_location.unwrap_or_default());
    network_to_model.radio_station = Set(new_radio_station);
    network_to_model.updated_at = Set(Utc::now().naive_utc());
    network_to_model.updated_by = Set(Some(login.clone()));
    network_to_model.active_from = Set(network_active_from);
    network_to_model.active_to = Set(network_active_to);
    network_to_model.update(txn).await.context(h!())?;

    // delete old freqs and freqs descriptions
    sigint_network_freq::Entity::delete_many()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id_from))
        .exec(txn)
        .await
        .context(h!())?;

    // Mark network_from as deleted, set merget_to field
    let mut network_from_model: sigint_network::ActiveModel =
        network_from.into();
    network_from_model.deleted = Set(true);
    network_from_model.merged_to = Set(Some(network_id_to));
    network_from_model.updated_at = Set(Utc::now().naive_utc());
    network_from_model.updated_by = Set(Some(login));
    network_from_model.update(txn).await.context(h!())?;

    println!("✅ Merged network {network_id_from} into {network_id_to}");

    Ok(())
}

/// Concatenates unique values from `from` to `to`
/// Only appends `from` if it is not already present in `to` as a separate part
fn concat_unique(to: Option<String>, from: Option<String>) -> Option<String> {
    match (to.as_deref(), from.as_deref()) {
        (Some(to_val), Some(from_val)) => {
            let parts: Vec<&str> = to_val.split('|').collect();
            if parts.contains(&from_val) {
                Some(to_val.to_string()) // Already present, return as is
            } else {
                Some(format!("{to_val}|{from_val}")) // Append uniquely
            }
        }
        (Some(to_val), None) => Some(to_val.to_string()),
        (None, Some(from_val)) => Some(from_val.to_string()),
        _ => None,
    }
}

/// Знаходить в базі даних діапазон активності мережі на основі активності частот
pub async fn get_network_activity_range<'a, 'async_trait, C>(
    txn: &'a C,
    network_id: i64,
) -> Result<(Option<NaiveDateTime>, Option<NaiveDateTime>), AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let freqs = sigint_network_freq::Entity::find()
        .filter(sigint_network_freq::Column::NetworkId.eq(network_id))
        .all(txn)
        .await
        .context(h!())?;

    if freqs.is_empty() {
        return Ok((None, None));
    }

    let ranges: Vec<(NaiveDateTime, Option<NaiveDateTime>)> = freqs
        .into_iter()
        .map(|f| (f.active_from, f.active_to))
        .collect();

    Ok(compute_network_activity_range(&Some(ranges)))
}

/// Обраховує діапазон активності мережі на основі активності частот
pub fn compute_network_activity_range(
    freq_ranges: &Option<Vec<(NaiveDateTime, Option<NaiveDateTime>)>>,
) -> (Option<NaiveDateTime>, Option<NaiveDateTime>) {
    match freq_ranges {
        Some(ranges) if !ranges.is_empty() => {
            let active_from = ranges.iter().map(|(from, _)| *from).min();

            let active_to = if ranges.iter().all(|(_, to)| to.is_some()) {
                ranges.iter().filter_map(|(_, to)| *to).max()
            } else {
                None
            };

            (active_from, active_to)
        }
        _ => (None, None),
    }
}

#[derive(FromQueryResult)]
struct CountResult {
    count: i64,
}

pub async fn bl_get_network_active_freqs_count(
    dbx: &DbConn,
    groups: &Vec<String>,
    start_date: NaiveDateTime,
    end_date: NaiveDateTime,
) -> Result<i64, AppError> {
    // First CTE - network_freqs
    let network_freqs = build_network_freqs_query();
    let network_freqs_cte = CommonTableExpression::new()
        .query(network_freqs)
        .table_name(Alias::new("network_freqs"))
        .to_owned();

    let nf = Alias::new("nf");
    let conditions = build_signal_message_conditions(
        groups,
        start_date,
        end_date,
        nf.clone(),
    );

    // Second CTE - network_messages
    let network_messages = Query::select()
        .columns([
            (sigint_inbox_item::Entity, sigint_inbox_item::Column::Id),
            (sigint_inbox_item::Entity, sigint_inbox_item::Column::Freq),
            (
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Datetime,
            ),
        ])
        .from(signal_message::Entity)
        .join(
            JoinType::InnerJoin,
            datasource_group::Entity,
            SeaExpr::col((signal_message::Entity, signal_message::Column::DatasourceGroupId))
                .equals((
                    datasource_group::Entity,
                    datasource_group::Column::Id,
                )),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Entity,
            SeaExpr::col((signal_message::Entity, signal_message::Column::Id))
                .equals((
                    sigint_inbox_item::Entity,
                    sigint_inbox_item::Column::Id,
                )),
        )
        .cond_where(conditions)
        .to_owned();
    let network_messages_cte = CommonTableExpression::new()
        .query(network_messages)
        .table_name(Alias::new("network_messages"))
        .to_owned();

    // Final query
    let main_query = Query::select()
        .expr(Expr::col(Alias::new("freq")).count_distinct())
        .from(Alias::new("network_messages"))
        .to_owned();

    // Combine CTEs and execute
    let query = Query::with()
        .cte(network_freqs_cte)
        .clone()
        .cte(network_messages_cte)
        .clone()
        .query(main_query)
        .to_owned();

    fetch_count(dbx, query).await
}

pub async fn bl_get_network_active_callsigns_count(
    dbx: &DbConn,
    groups: &Vec<String>,
    start_date: NaiveDateTime,
    end_date: NaiveDateTime,
) -> Result<i64, AppError> {
    // First CTE - network_freqs
    let network_freqs = build_network_freqs_query();
    let network_freqs_cte = CommonTableExpression::new()
        .query(network_freqs)
        .table_name(Alias::new("network_freqs"))
        .to_owned();

    // Second CTE - network callsingns
    let network_callsigns = build_network_callsigns_query();
    let network_callsigns_cte = CommonTableExpression::new()
        .query(network_callsigns)
        .table_name(Alias::new("network_callsigns"))
        .to_owned();

    // Third CTE: network_messages
    let nf = Alias::new("nf");
    let conditions = build_signal_message_conditions(
        groups,
        start_date,
        end_date,
        nf.clone(),
    );

    let network_messages = Query::select()
        .columns([
            (sigint_inbox_item::Entity, sigint_inbox_item::Column::Id),
            (sigint_inbox_item::Entity, sigint_inbox_item::Column::Freq),
            (
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Datetime,
            ),
        ])
        .expr_as(
            Expr::cust(
                "jsonb_array_elements_text(sigint_inbox_item.callsigns)",
            ),
            Alias::new("callsign"),
        )
        .from(signal_message::Entity)
        .join(
            JoinType::InnerJoin,
            datasource_group::Entity,
            SeaExpr::col((signal_message::Entity, signal_message::Column::DatasourceGroupId))
                .equals((
                    datasource_group::Entity,
                    datasource_group::Column::Id,
                )),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Entity,
            Expr::col((signal_message::Entity, signal_message::Column::Id))
                .equals((
                    sigint_inbox_item::Entity,
                    sigint_inbox_item::Column::Id,
                )),
        )
        .cond_where(conditions)
        .to_owned();

    let network_messages_cte = CommonTableExpression::new()
        .query(network_messages)
        .table_name(Alias::new("network_messages"))
        .to_owned();

    // Final query
    let main_query = Query::select()
        .expr(Expr::col((Alias::new("c"), "sigint_callsign")).count_distinct())
        .from_as(Alias::new("network_callsigns"), Alias::new("c"))
        .and_where(Expr::exists(
            Query::select()
                .expr(Expr::value(1))
                .from_as(Alias::new("network_messages"), Alias::new("m"))
                .and_where(
                    Expr::col((Alias::new("m"), "callsign"))
                        .equals((Alias::new("c"), "sigint_callsign")),
                )
                .to_owned(),
        ))
        .to_owned();

    // Combine CTEs and execute
    let query = Query::with()
        .cte(network_freqs_cte)
        .clone()
        .cte(network_callsigns_cte)
        .clone()
        .cte(network_messages_cte)
        .clone()
        .query(main_query)
        .to_owned();

    fetch_count(dbx, query).await
}

/// Run a COUNT(*) query and return the result as `i64`
pub async fn fetch_count(
    dbx: &DatabaseConnection,
    query: WithQuery,
) -> Result<i64, AppError> {
    let (sql, values) = query.build(PostgresQueryBuilder);

    let result = CountResult::find_by_statement(
        Statement::from_sql_and_values(DbBackend::Postgres, sql, values),
    )
    .one(dbx)
    .await?;

    Ok(result.map_or(0, |r| r.count))
}

/// Build query to select all network frequencies
fn build_network_freqs_query() -> sea_query::SelectStatement {
    Query::select()
        .columns([
            (
                sigint_network_freq::Entity,
                sigint_network_freq::Column::NetworkId,
            ),
            (
                sigint_network_freq::Entity,
                sigint_network_freq::Column::Freq,
            ),
            (
                sigint_network_freq::Entity,
                sigint_network_freq::Column::ActiveFrom,
            ),
            (
                sigint_network_freq::Entity,
                sigint_network_freq::Column::ActiveTo,
            ),
        ])
        .from(sigint_network::Entity)
        .join(
            JoinType::InnerJoin,
            sigint_network_freq::Entity,
            SeaExpr::col((sigint_network::Entity, sigint_network::Column::Id))
                .equals((
                    sigint_network_freq::Entity,
                    sigint_network_freq::Column::NetworkId,
                )),
        )
        .and_where(sigint_network::Column::Deleted.eq(false))
        .and_where(sigint_network_freq::Column::Deleted.eq(false))
        .to_owned()
}

/// Build query to select all network callsigns
fn build_network_callsigns_query() -> sea_query::SelectStatement {
    Query::select()
        .columns([
            (
                sigint_network_callsign::Entity,
                sigint_network_callsign::Column::SigintNetworkId,
            ),
            (
                sigint_network_callsign::Entity,
                sigint_network_callsign::Column::SigintCallsign,
            ),
        ])
        .from(sigint_network::Entity)
        .join(
            JoinType::InnerJoin,
            sigint_network_callsign::Entity,
            SeaExpr::col((sigint_network::Entity, sigint_network::Column::Id))
                .equals((
                    sigint_network_callsign::Entity,
                    sigint_network_callsign::Column::SigintNetworkId,
                )),
        )
        .and_where(sigint_network::Column::Deleted.eq(false))
        .and_where(sigint_network_callsign::Column::Deleted.eq(false))
        .to_owned()
}

/// Builds a reusable condition for filtering signal messages
pub fn build_signal_message_conditions(
    groups: &Vec<String>,
    start_date: NaiveDateTime,
    end_date: NaiveDateTime,
    nf: Alias,
) -> Condition {
    Condition::all()
        .add(signal_message::Column::Deleted.eq(false))
        .add(datasource_group::Column::GroupMasterKey.is_in(groups))
        .add(
            SeaExpr::col((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Datetime,
            ))
            .gte(start_date),
        )
        .add(
            SeaExpr::col((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Datetime,
            ))
            .lt(end_date),
        )
        .add(SeaExpr::exists(
            Query::select()
                .expr(SeaExpr::value(1))
                .from_as(Alias::new("network_freqs"), nf.clone())
                .and_where(SeaExpr::col((nf.clone(), "freq")).equals((
                    sigint_inbox_item::Entity,
                    sigint_inbox_item::Column::Freq,
                )))
                .and_where(
                    SeaExpr::col((
                        sigint_inbox_item::Entity,
                        sigint_inbox_item::Column::Datetime,
                    ))
                    .gte(SeaExpr::col((nf.clone(), "active_from"))),
                )
                .and_where(
                    Expr::col((
                        sigint_inbox_item::Entity,
                        sigint_inbox_item::Column::Datetime,
                    ))
                    .lt(Expr::expr(
                        Expr::cust_with_values(
                            "COALESCE(nf.active_to, $1)",
                            vec![end_date],
                        ),
                    )),
                )
                .to_owned(),
        ))
}
