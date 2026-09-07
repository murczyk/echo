use crate::entities::sigint_network;
use crate::entities::*;
use crate::error::AppError;
use crate::rer_importer::types::{InboxMapItem, MapPointsFilter};
use crate::sigint::network::types::*;
use crate::types::*;
use crate::users::ensure_rer_role;
use crate::utils::*;
use actix_web::web::Json;
use chrono::*;
use itertools::Itertools;
use sea_orm::sea_query::*;
use sea_orm::*;
use sea_query::Expr as SeaExpr;

pub async fn render_networks<'a, 'async_trait, C>(
    networks: Vec<sigint_network::Model>,
    txn: &'a C,
    user_login: &uuid::Uuid,
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
    let network_freqs =
        get_networks_freqs(txn, &networks, &network_ids, user_login)
            .await
            .context(h!())?;
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
    let updated_by_login_ids = networks
        .iter()
        .filter_map(|network| network.updated_by_login_id)
        .unique()
        .collect_vec();
    let updated_by_logins = if updated_by_login_ids.is_empty() {
        HashMap::new()
    } else {
        crate::users::login_names_by_ids(txn, updated_by_login_ids)
            .await
            .context(h!())?
    };

    let mut networks_res = Vec::with_capacity(networks.len());
    for network in &networks {
        networks_res.push(Network {
            id: network.id,
            freqs: network_freqs
                .freqs_by_network_id
                .get(&network.id)
                .cloned()
                .unwrap_or_default(),
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
            last_activity_at: network_freqs
                .last_activity_by_network_id
                .get(&network.id)
                .map(|timestamp| timestamp.and_utc().timestamp_millis()),
            last_updated_at: network.updated_at.and_utc().timestamp_millis(),
            last_updated_by: network.updated_by_login_id.map(|login_id| {
                updated_by_logins
                    .get(&login_id)
                    .cloned()
                    .unwrap_or_else(|| login_id.to_string())
            }),
            active_from: network
                .active_from
                .map(|d| d.and_utc().timestamp_millis()),
            active_to: network
                .active_to
                .map(|d| d.and_utc().timestamp_millis()),
            deleted: network.deleted,
            do_not_archive: network.do_not_archive,
            unit_mask: crate::sigint::unit_tag::sigint_network_unit_mask(
                network,
            ),
            status: if network.active_to.is_some() {
                NetworkStatus::NetworkInactive
            } else {
                NetworkStatus::NetworkActive
            },
        });
    }
    trace!(
        "> render_networks execution time for {} networks is: {:?}",
        &networks.len(),
        instant.elapsed()
    );
    Ok(networks_res)
}

struct NetworkFreqs {
    freqs_by_network_id: HashMap<i64, Vec<NetworkFreq>>,
    last_activity_by_network_id: HashMap<i64, NaiveDateTime>,
}

async fn get_networks_freqs<'a, 'async_trait, C>(
    txn: &'a C,
    networks: &[sigint_network::Model],
    network_ids: &[i64],
    user_login: &uuid::Uuid,
) -> Result<NetworkFreqs, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if network_ids.is_empty() {
        return Ok(NetworkFreqs {
            freqs_by_network_id: HashMap::new(),
            last_activity_by_network_id: HashMap::new(),
        });
    }

    let freqs = sigint_network_freq::Entity::find()
        .filter(
            sigint_network_freq::Column::NetworkId.eq_any(network_ids.to_vec()),
        )
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .all(txn)
        .await
        .context(h!())?;

    let freq_ids = freqs.iter().map(|x| x.id).collect::<Vec<_>>();

    let mut keys =
        crate::sigint::key::load_freq_keys(txn, user_login, freq_ids)
            .await
            .c(h!())?;

    let networks_by_id = networks
        .iter()
        .map(|network| (network.id, network))
        .collect::<HashMap<_, _>>();
    let mut freqs_by_network_id: HashMap<i64, Vec<NetworkFreq>> =
        HashMap::new();
    let mut last_activity_by_network_id = HashMap::new();

    for freq in freqs {
        if let (Some(network), Some(last_seen_dt)) =
            (networks_by_id.get(&freq.network_id), freq.last_seen_dt)
        {
            if is_last_seen_in_activity_range(
                last_seen_dt,
                network.active_from,
                network.active_to,
                freq.active_from,
                freq.active_to,
            ) {
                last_activity_by_network_id
                    .entry(freq.network_id)
                    .and_modify(|current| {
                        *current = std::cmp::max(*current, last_seen_dt)
                    })
                    .or_insert(last_seen_dt);
            }
        }
        let keys = keys.remove(&freq.id).unwrap_or_default();
        freqs_by_network_id
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
                modulation: freq.modulation.clone(),
                encryption_id: freq.encryption_id,
                encryption_keys: keys,
            });
    }

    Ok(NetworkFreqs {
        freqs_by_network_id,
        last_activity_by_network_id,
    })
}

fn is_last_seen_in_activity_range(
    last_seen_dt: NaiveDateTime,
    network_active_from: Option<NaiveDateTime>,
    network_active_to: Option<NaiveDateTime>,
    freq_active_from: NaiveDateTime,
    freq_active_to: Option<NaiveDateTime>,
) -> bool {
    network_active_from
        .map(|active_from| active_from <= last_seen_dt)
        .unwrap_or(true)
        && network_active_to
            .map(|active_to| last_seen_dt <= active_to)
            .unwrap_or(true)
        && freq_active_from <= last_seen_dt
        && freq_active_to
            .map(|active_to| last_seen_dt <= active_to)
            .unwrap_or(true)
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
            sigint_network_unit::Column::NetworkId.eq_any(network_ids.to_vec()),
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
            sigint_network_post::Column::NetworkId.eq_any(network_ids.to_vec()),
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
            sigint_network_aor::Column::NetworkId.eq_any(network_ids.to_vec()),
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
                .eq_any(network_ids.to_vec()),
        )
        .filter(sigint_network_description::Column::Deleted.eq(false))
        .order_by_asc(sigint_network_description::Column::Type)
        .order_by_asc(sigint_network_description::Column::CreatedAt)
        .all(txn)
        .await
        .context(h!())?;
    let login_names = crate::users::login_names_by_ids(
        txn,
        network_descriptions
            .iter()
            .map(|item| item.login_id)
            .collect(),
    )
    .await?;

    let mut descr_map: HashMap<i64, Vec<NetworkDescription>> = HashMap::new();

    for x in network_descriptions {
        let descr = NetworkDescription {
            id: x.id,
            network_id: x.network_id,
            network_frequency_id: x.sigint_network_freq_id,
            descr_type: NetworkDescrType::from(x.r#type.clone()),
            topic: if x.topic.trim().is_empty() {
                None
            } else {
                Some(x.topic.clone())
            },
            description: x.description.clone(),
            // comment: x.comment.clone(),
            login: login_names[&x.login_id].clone(),
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
    user_login: &uuid::Uuid,
) -> Result<Vec<Network>, AppError> {
    let sel = sigint_network_freq::Entity::find()
        .filter(
            sigint_network_freq::Column::NetworkId
                .into_simple_expr()
                .eq(sigint_network::Column::Id.into_simple_expr()),
        )
        .filter(sigint_network_freq::Column::Freq.eq_any(freqs));

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
    Ok(render_networks(networks, txn, user_login)
        .await
        .context(h!())?)
}

pub async fn bl_network_info_batch(
    network_ids: Vec<i64>,
    txn: &DatabaseTransaction,
    user_login: &uuid::Uuid,
) -> Result<Vec<Network>, AppError> {
    let networks = sigint_network::Entity::find()
        .filter(sigint_network::Column::Id.eq_any(network_ids));
    // .order_by_asc(sigint_network::Column::Freq);

    // println!(
    //     "> bl_network_info_batch sql: {}",
    //     networks_with_modulation.clone().build(DbBackend::Postgres).to_string()
    // );

    let networks = networks.all(txn).await.context(h!())?;
    Ok(render_networks(networks, txn, user_login)
        .await
        .context(h!())?)
}

pub async fn network_group_activity_bl(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<NetworkGroupsActivityReq>,
) -> Result<HashMap<String, HashMap<String, HashMap<String, i64>>>, AppError> {
    ensure_rer_role(&env.dbx, &user).await.context(h!())?;
    let dt_till = if let Some(till) = req.till_date_noninclusive_ms {
        dt_from_millis(till).context(h!())?
    } else {
        Utc::now().naive_utc()
    };
    let dt_since = dt_till
        .checked_sub_signed(TimeDelta::days(
            req.period.unwrap_or_default().lookback_days(),
        ))
        .context(h!())?;

    let groups = crate::messenger::group::get_identity_sigint_groups_noimport(
        &env.dbx,
        &user,
        &env.config,
    )
    .await
    .context(h!())?;
    let source_db = env.dbx.clone();
    let analytics_groups = groups.clone();
    let postgres_groups = groups;
    let analytics_network_ids = req.network_ids.clone();
    let postgres_network_ids = req.network_ids.clone();

    crate::rer_importer::analysis::with_analytics_read_fallback(
        &env,
        "network group activity",
        true,
        move |analytics_db| async move {
            crate::sigint::network::analytics::load_network_group_activity(
                &source_db,
                &analytics_db,
                &analytics_groups,
                &analytics_network_ids,
                dt_since,
                dt_till,
            )
            .await
        },
        move |postgres_db| async move {
            load_network_group_activity_postgres(
                &postgres_db,
                &postgres_groups,
                &postgres_network_ids,
                dt_since,
                dt_till,
            )
            .await
        },
    )
    .await
}

async fn load_network_group_activity_postgres(
    db: &DatabaseConnection,
    groups: &[String],
    network_ids: &[i64],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<HashMap<String, HashMap<String, HashMap<String, i64>>>, AppError> {
    if groups.is_empty() || network_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let networks_group_stat = signal_message::Entity::find()
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
            Alias::new("sigint_inbox_item"),
        )
        .join_as(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintInboxItemNetwork.def(),
            Alias::new("sigint_inbox_item_network"),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Relation::SigintNetwork.def(),
        )
        .join_as(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
            Alias::new("datasource_group"),
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
        .column_as(
            sigint_inbox_item_network::Column::SigintNetworkId,
            "network_id",
        )
        .column_as(signal_group::Column::Name, "group")
        .column_as(Expr::cust("count(*)"), "count")
        .group_by(Expr::cust(
            "network_id, day, signal_group.name",
        ))
        .filter(signal_group::Column::Deleted.eq(false))
        .filter(signal_group::Column::IsArchived.eq(false))
        .filter(
            datasource_group::Column::GroupMasterKey.eq_any(groups.to_vec()),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.lte(dt_till))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(
            Expr::col(sigint_network::Column::ActiveFrom)
                .is_null()
                .or(Expr::col(sigint_inbox_item::Column::Datetime)
                    .gte(Expr::col(sigint_network::Column::ActiveFrom))),
        )
        .filter(
            Expr::col(sigint_network::Column::ActiveTo)
                .is_null()
                .or(Expr::col(sigint_inbox_item::Column::Datetime)
                    .lte(Expr::col(sigint_network::Column::ActiveTo))),
        )
        .filter(
            sigint_inbox_item_network::Column::SigintNetworkId
                .eq_any(network_ids.to_vec()),
        );

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
        .all(db)
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
    active_range: Option<(NaiveDateTime, NaiveDateTime)>,
) -> anyhow::Result<BTreeMap<String, Vec<sigint_unit::Model>>> {
    let freqs = inbox_items
        .iter()
        .filter_map(|x| x.freq.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect_vec();
    let now = Utc::now().naive_utc();
    let mut freq_networks = sigint_network::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network::Relation::SigintNetworkFreq.def(),
        )
        .filter(sigint_network_freq::Column::Freq.eq_any(freqs))
        .filter(sigint_network_freq::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false));
    let freq_active_now = sigint_network_freq::Column::ActiveTo
        .is_null()
        .or(sigint_network_freq::Column::ActiveTo.gte(now))
        .and(
            sigint_network_freq::Column::ActiveFrom
                .is_null()
                .or(sigint_network_freq::Column::ActiveFrom.lte(now)),
        );
    let network_active_now = sigint_network::Column::ActiveTo
        .is_null()
        .or(sigint_network::Column::ActiveTo.gte(now))
        .and(
            sigint_network::Column::ActiveFrom
                .is_null()
                .or(sigint_network::Column::ActiveFrom.lte(now)),
        );
    freq_networks = freq_networks
        .filter(freq_active_now)
        .filter(network_active_now);
    if let Some((dt_since, dt_till)) = active_range {
        let freq_active_filter =
            crate::sigint::freq::util::filter_by_active_ts(dt_since, dt_till);
        let network_active_to_ok = sigint_network::Column::ActiveTo
            .is_null()
            .or(sigint_network::Column::ActiveTo.gte(dt_since));
        let network_active_from_ok = sigint_network::Column::ActiveFrom
            .is_null()
            .or(sigint_network::Column::ActiveFrom.lte(dt_till));
        freq_networks = freq_networks
            .filter(freq_active_filter)
            .filter(network_active_to_ok.and(network_active_from_ok));
    }
    let freq_networks = freq_networks
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
        .filter(sigint_network_unit::Column::NetworkId.eq_any(network_ids))
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
        .filter(sigint_network::Column::Id.eq_any(network_ids))
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
    let conditions = Condition::all()
        .add(signal_message::Column::Deleted.eq(false))
        .add(datasource_group::Column::GroupMasterKey.eq_any(groups.clone()))
        .add(sigint_inbox_item::Column::Datetime.gte(start_date))
        .add(sigint_inbox_item::Column::Datetime.lt(end_date))
        .add(sigint_network::Column::Deleted.eq(false));

    // CTE - network_messages
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
            SeaExpr::col((
                signal_message::Entity,
                signal_message::Column::DatasourceGroupId,
            ))
            .equals((datasource_group::Entity, datasource_group::Column::Id)),
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
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Entity,
            SeaExpr::col((
                sigint_inbox_item::Entity,
                sigint_inbox_item::Column::Id,
            ))
            .equals((
                sigint_inbox_item_network::Entity,
                sigint_inbox_item_network::Column::SigintInboxItemId,
            )),
        )
        .join(
            JoinType::InnerJoin,
            sigint_network::Entity,
            SeaExpr::col((
                sigint_inbox_item_network::Entity,
                sigint_inbox_item_network::Column::SigintNetworkId,
            ))
            .equals((sigint_network::Entity, sigint_network::Column::Id)),
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
    let inbox_item_ids = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item::Relation::SigintInboxItemNetwork.def(),
        )
        .join(
            JoinType::InnerJoin,
            sigint_inbox_item_network::Relation::SigintNetwork.def(),
        )
        .select_only()
        .column(sigint_inbox_item::Column::Id)
        .distinct()
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(datasource_group::Column::GroupMasterKey.eq_any(groups.clone()))
        .filter(sigint_inbox_item::Column::Datetime.gte(start_date))
        .filter(sigint_inbox_item::Column::Datetime.lt(end_date))
        .filter(sigint_network::Column::Deleted.eq(false))
        .into_tuple::<i64>()
        .all(dbx)
        .await
        .c(h!())?;
    let message_callsigns =
        crate::inbox::callsigns::load_by_item_ids(dbx, &inbox_item_ids)
            .await?
            .into_values()
            .flat_map(|callsigns| callsigns.effective())
            .collect::<HashSet<_>>();
    if message_callsigns.is_empty() {
        return Ok(0);
    }
    let active_network_callsigns = sigint_network_callsign::Entity::find()
        .join(
            JoinType::InnerJoin,
            sigint_network_callsign::Relation::SigintNetwork.def(),
        )
        .select_only()
        .column(sigint_network_callsign::Column::SigintCallsign)
        .distinct()
        .filter(sigint_network_callsign::Column::Deleted.eq(false))
        .filter(sigint_network::Column::Deleted.eq(false))
        .into_tuple::<String>()
        .all(dbx)
        .await
        .c(h!())?;
    Ok(active_network_callsigns
        .into_iter()
        .filter(|callsign| message_callsigns.contains(callsign))
        .count() as i64)
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
    .await
    .c(h!())?;

    Ok(result.map_or(0, |r| r.count))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dt(day: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 9, day)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    }

    // Regression for ECHO-3207: stale cached activity must not escape closed ranges.
    #[test]
    fn last_seen_must_be_inside_network_and_frequency_ranges() {
        assert!(is_last_seen_in_activity_range(
            dt(5),
            Some(dt(1)),
            Some(dt(7)),
            dt(2),
            Some(dt(6)),
        ));
        assert!(!is_last_seen_in_activity_range(
            dt(8),
            Some(dt(1)),
            Some(dt(7)),
            dt(2),
            None,
        ));
        assert!(!is_last_seen_in_activity_range(
            dt(7),
            Some(dt(1)),
            None,
            dt(2),
            Some(dt(6)),
        ));
    }
}
