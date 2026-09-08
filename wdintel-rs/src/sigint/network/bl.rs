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

pub(crate) struct NetworkRenderAccess {
    pub(crate) activity_groups: Vec<String>,
    load_encryption_keys: bool,
}

pub(crate) async fn load_network_render_access<'a, 'async_trait, C>(
    txn: &'a C,
    user_login: &uuid::Uuid,
) -> Result<NetworkRenderAccess, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let login = crate::users::load_active_login(txn, user_login)
        .await
        .c(h!())?;
    if login.sigint_zone_id.is_some() && login.organism_id.is_some() {
        let activity_groups =
            crate::messenger::group::get_identity_sigint_groups(
                txn, user_login,
            )
            .await
            .context(h!())?;
        return Ok(NetworkRenderAccess {
            activity_groups,
            load_encryption_keys: true,
        });
    }

    let roles: Vec<String> = serde_json::from_value(login.roles).c(h!())?;
    let is_api = crate::users::role_matches(&roles, "Api").context(h!())?
        || crate::users::role_matches(&roles, "ApiAgent").context(h!())?;
    if is_api {
        return Ok(NetworkRenderAccess {
            activity_groups: Vec::new(),
            load_encryption_keys: login.organism_id.is_some(),
        });
    }

    let activity_groups =
        crate::messenger::group::get_identity_sigint_groups(txn, user_login)
            .await
            .context(h!())?;
    Ok(NetworkRenderAccess {
        activity_groups,
        load_encryption_keys: login.organism_id.is_some(),
    })
}

pub async fn render_networks<'a, 'async_trait, C>(
    networks: Vec<sigint_network::Model>,
    txn: &'a C,
    user_login: &uuid::Uuid,
) -> Result<Vec<Network>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if networks.is_empty() {
        return Ok(vec![]);
    }

    let access = load_network_render_access(txn, user_login)
        .await
        .context(h!())?;
    Ok(
        render_networks_with_access(networks, txn, user_login, &access)
            .await
            .context(h!())?,
    )
}

pub(crate) async fn render_networks_with_access<'a, 'async_trait, C>(
    networks: Vec<sigint_network::Model>,
    txn: &'a C,
    user_login: &uuid::Uuid,
    access: &NetworkRenderAccess,
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
        get_networks_freqs(txn, &network_ids, user_login, access)
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
    network_ids: &[i64],
    user_login: &uuid::Uuid,
    access: &NetworkRenderAccess,
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

    let mut keys = if access.load_encryption_keys {
        crate::sigint::key::load_freq_keys(txn, user_login, freq_ids)
            .await
            .c(h!())?
    } else {
        HashMap::new()
    };

    let mut freqs_by_network_id: HashMap<i64, Vec<NetworkFreq>> =
        HashMap::new();

    for freq in freqs {
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

    let last_activity_by_network_id =
        load_network_last_activity(txn, network_ids, &access.activity_groups)
            .await
            .context(h!())?;

    Ok(NetworkFreqs {
        freqs_by_network_id,
        last_activity_by_network_id,
    })
}

async fn load_network_last_activity<'a, 'async_trait, C>(
    txn: &'a C,
    network_ids: &[i64],
    groups: &[String],
) -> Result<HashMap<i64, NaiveDateTime>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    if network_ids.is_empty() || groups.is_empty() {
        return Ok(HashMap::new());
    }

    #[derive(FromQueryResult)]
    struct NetworkLastActivity {
        network_id: i64,
        last_activity_at: Option<NaiveDateTime>,
    }

    Ok(sigint_network::Entity::find()
        .select_only()
        .column_as(sigint_network::Column::Id, "network_id")
        .column_as(
            crate::sigint::network::sort::network_last_activity_sort_expr(
                groups,
            ),
            "last_activity_at",
        )
        .filter(sigint_network::Column::Id.eq_any(network_ids.to_vec()))
        .into_model::<NetworkLastActivity>()
        .all(txn)
        .await
        .context(h!())?
        .into_iter()
        .filter_map(|row| {
            row.last_activity_at
                .map(|last_activity_at| (row.network_id, last_activity_at))
        })
        .collect())
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
    let (dt_since, dt_till) =
        network_group_activity_bounds(dt_till, req.period.unwrap_or_default())
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
                "(EXTRACT(EPOCH FROM DATE_TRUNC('day', COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at) AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Kyiv')) * 1000)::BIGINT",
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
        .filter(network_activity_timestamp().lt(dt_till))
        .filter(network_activity_timestamp().gte(dt_since))
        .filter(
            Expr::col(sigint_network::Column::ActiveFrom)
                .is_null()
                .or(network_activity_timestamp()
                    .gte(Expr::col(sigint_network::Column::ActiveFrom))),
        )
        .filter(
            Expr::col(sigint_network::Column::ActiveTo)
                .is_null()
                .or(network_activity_timestamp()
                    .lte(Expr::col(sigint_network::Column::ActiveTo))),
        )
        .filter(network_activity_has_matching_frequency())
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

fn network_activity_timestamp() -> SimpleExpr {
    Expr::cust(
        "COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at)",
    )
}

fn network_group_activity_bounds(
    till: NaiveDateTime,
    period: NetworkGroupActivityPeriod,
) -> Result<(NaiveDateTime, NaiveDateTime), AppError> {
    let lookback_days =
        <u64 as TryFrom<i64>>::try_from(period.lookback_days()).c(h!())?;
    let till = till.and_utc().with_timezone(&Kyiv);
    let since = till
        .checked_sub_days(Days::new(lookback_days))
        .context(h!())?;
    Ok((
        since.with_timezone(&Utc).naive_utc(),
        till.with_timezone(&Utc).naive_utc(),
    ))
}

fn network_activity_has_matching_frequency() -> SimpleExpr {
    Expr::cust(
        r#"EXISTS (
            SELECT 1
            FROM sigint_network_freq network_freq
            WHERE network_freq.network_id = sigint_inbox_item_network.sigint_network_id
              AND network_freq.freq = sigint_inbox_item.freq
              AND network_freq.deleted = false
              AND COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at) >= network_freq.active_from
              AND (
                  network_freq.active_to IS NULL
                  OR COALESCE(sigint_inbox_item.datetime, signal_message.timestamp, signal_message.created_at) <= network_freq.active_to
              )
        )"#,
    )
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
    use crate::functest::tests::*;
    use serial_test::serial;

    fn dt(day: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 9, day)
            .unwrap()
            .and_hms_opt(12, 0, 0)
            .unwrap()
    }

    #[test]
    fn network_activity_bounds_follow_kyiv_calendar_days() {
        let till = Kyiv
            .with_ymd_and_hms(2026, 11, 2, 0, 0, 0)
            .single()
            .unwrap()
            .with_timezone(&Utc)
            .naive_utc();

        let (since, actual_till) = network_group_activity_bounds(
            till,
            NetworkGroupActivityPeriod::Last10Days,
        )
        .unwrap();

        let expected_since = Kyiv
            .with_ymd_and_hms(2026, 10, 23, 0, 0, 0)
            .single()
            .unwrap()
            .with_timezone(&Utc)
            .naive_utc();
        assert_eq!(since, expected_since);
        assert_eq!(actual_till, till);
    }

    async fn seed_network_activity(
        dbx: &DatabaseConnection,
        network_id: i64,
        datasource_group_id: i64,
        freq: &str,
        timestamp: NaiveDateTime,
    ) {
        let message = mk_signal_message(
            dbx,
            signal_message::ActiveModel {
                datasource_group_id: Set(Some(datasource_group_id)),
                timestamp: Set(Some(timestamp)),
                created_at: Set(timestamp),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let inbox_item = mk_sigint_inbox_item(
            dbx,
            sigint_inbox_item::ActiveModel {
                id: Set(message.id),
                freq: Set(Some(freq.to_string())),
                datetime: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_inbox_item_network(
            dbx,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(inbox_item.id),
                sigint_network_id: Set(network_id),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    }

    // Regression for ECHO-3207: API network reads must not require SIGINT scope.
    #[tokio::test]
    #[serial]
    async fn unscoped_api_renders_network_with_null_activity() {
        let env = cleanup().await.unwrap();
        let login = mk_login(
            &env.dbx,
            login::ActiveModel {
                login: Set("unscoped-network-api".to_string()),
                roles: Set(serde_json::to_value(vec![crate::config::ROLE_API])
                    .unwrap()),
                sigint_zone_id: Set(None),
                organism_id: Set(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                ..Default::default()
            },
        )
        .await
        .unwrap();
        mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set("146.5000".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        let rendered = render_networks(vec![network], &env.dbx, &login.id)
            .await
            .unwrap();

        assert_eq!(rendered.len(), 1);
        assert_eq!(rendered[0].last_activity_at, None);
        assert_eq!(rendered[0].freqs.len(), 1);
        assert!(rendered[0].freqs[0].encryption_keys.is_empty());
    }

    // Regression for ECHO-3207: activity must honor group access and frequency ranges.
    #[tokio::test]
    #[serial]
    async fn network_activity_uses_authorized_groups_and_active_frequencies() {
        let env = cleanup().await.unwrap();
        let datasource = find_test_datasource(&env.dbx).await.unwrap();
        let allowed_group = find_test_signal_group(&env.dbx).await.unwrap();
        let allowed_datasource_group =
            find_test_datasource_group(&env.dbx).await.unwrap();
        let hidden_group = mk_signal_group(
            &env.dbx,
            signal_group::ActiveModel {
                datasource_id: Set(Some(datasource.id)),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let hidden_datasource_group = mk_datasource_group(
            &env.dbx,
            datasource_group::ActiveModel {
                datasource_id: Set(datasource.id),
                group_master_key: Set(hidden_group.master_key),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let network = mk_sigint_network(
            &env.dbx,
            sigint_network::ActiveModel {
                active_from: Set(Some(dt(1))),
                active_to: Set(Some(dt(7))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let freq = "146.5000";
        mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set(freq.to_string()),
                active_from: Set(dt(1)),
                active_to: Set(Some(dt(5))),
                last_seen_dt: Set(Some(dt(6))),
                ..Default::default()
            },
        )
        .await
        .unwrap();

        seed_network_activity(
            &env.dbx,
            network.id,
            allowed_datasource_group.id,
            freq,
            dt(2),
        )
        .await;
        seed_network_activity(
            &env.dbx,
            network.id,
            hidden_datasource_group.id,
            freq,
            dt(4),
        )
        .await;
        seed_network_activity(
            &env.dbx,
            network.id,
            allowed_datasource_group.id,
            freq,
            dt(6),
        )
        .await;

        let groups = vec![allowed_group.master_key];
        let last_activity =
            load_network_last_activity(&env.dbx, &[network.id], &groups)
                .await
                .unwrap();
        assert_eq!(last_activity.get(&network.id), Some(&dt(2)));

        let activity = load_network_group_activity_postgres(
            &env.dbx,
            &groups,
            &[network.id],
            dt(1),
            dt(7),
        )
        .await
        .unwrap();
        let message_count: i64 = activity
            .get(&network.id.to_string())
            .unwrap()
            .values()
            .flat_map(HashMap::values)
            .sum();
        assert_eq!(message_count, 1);

        let boundary_freq = "146.6000";
        mk_sigint_network_freq(
            &env.dbx,
            sigint_network_freq::ActiveModel {
                network_id: Set(network.id),
                freq: Set(boundary_freq.to_string()),
                active_from: Set(dt(1)),
                active_to: Set(Some(dt(7))),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        seed_network_activity(
            &env.dbx,
            network.id,
            allowed_datasource_group.id,
            boundary_freq,
            dt(7),
        )
        .await;

        let activity = load_network_group_activity_postgres(
            &env.dbx,
            &groups,
            &[network.id],
            dt(1),
            dt(7),
        )
        .await
        .unwrap();
        let message_count: i64 = activity
            .get(&network.id.to_string())
            .unwrap()
            .values()
            .flat_map(HashMap::values)
            .sum();
        assert_eq!(message_count, 1);
    }
}
