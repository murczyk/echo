use super::*;
use actix_web::post;
use std::collections::HashMap;
use tempfile::TempDir;

/// Summary table showing row-per-frequency
#[post("/api/rer/analysis/download-geojson")]
pub async fn rer_analysis_download_geojson(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
    http_req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let login = user.id()?;
    crate::users::has_role(&env.dbx, &login.clone(), "Rer").await?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_since_minus_24h =
        dt_from_millis(req.since_date_inclusive_ms - 24 * 60 * 60 * 1000)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;
    let include_peleng_locations =
        req.include_peleng_locations.unwrap_or(false);

    #[derive(FromQueryResult)]
    struct Res {
        // id: i64,
        freq: Option<String>,
        lat: Option<f64>,
        lng: Option<f64>,
        datetime: NaiveDateTime,
        group_name: String,
    }
    let items = signal_message::Entity::find()
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
            datasource_group::Relation::SignalGroup.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .select_only()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .column_as(sigint_inbox_item::Column::Id, "id")
        .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
        .column_as(signal_group::Column::Name, "group_name")
        .column_as(Expr::col(sigint_inbox_item::Column::Lat), "lat")
        .column_as(Expr::col(sigint_inbox_item::Column::Lng), "lng")
        .column_as(sigint_inbox_item::Column::Datetime, "datetime")
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(datasource_group::Column::GroupMasterKey.is_in(
            crate::users::get_identity_sigint_groups(&env.dbx, &login).await?,
        ))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(sigint_inbox_item::Column::Lat.is_not_null())
        .filter(sigint_inbox_item::Column::Lng.is_not_null());
    let items = filter_selected_freqs(items, &req.selected_freqs)?;
    let items = filter_selected_posts(items, &req.selected_posts)?;
    let items = filter_selected_groups(items, &req.selected_groups)?;
    let items = filter_selected_senders(items, &req.selected_senders)?;
    let items = filter_selected_units(
        items,
        &req.selected_units,
        &req.units_exact_match_only,
    )?;
    let items = filter_selected_callsigns(items, &req.selected_callsigns)?;
    let items = filter_selected_tags(
        items,
        &req.selected_tags,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &user.id()?,
        false,
    )?;
    let items =
        filter_selected_aors(items, &req.selected_aors).context(h!())?;
    let items = filter_search(items, &req.search)?;
    let items = filter_selected_locations(
        items,
        &req.selected_locations,
        include_peleng_locations,
    )?;
    // println!(
    //     "> download kmz items query: {}",
    //     items.build(DbBackend::Postgres).to_string()
    // );
    let items = items.into_model::<Res>().all(&env.dbx).await?;
    // Collect unique freqs from main query results
    let unique_freqs: HashSet<String> =
        items.iter().filter_map(|item| item.freq.clone()).collect();

    let tmp_dir = TempDir::new()?;
    let now = Utc::now();
    let outpath = tmp_dir
        .path()
        .join(format!("report-{}.geojson", now.format("%m%d-%H%M")));

    let filter_active_ts =
        crate::sigint::freq::util::filter_by_active_ts(dt_since, dt_till);

    // Pre-load networks
    let networks: HashMap<String, String> = sigint_network::Entity::find()
        .find_also_related(sigint_network_freq::Entity)
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(filter_active_ts)
        .filter(sigint_network_freq::Column::Freq.is_in(unique_freqs.clone()))
        .all(&env.dbx)
        .await
        .context(h!())?
        .into_iter()
        .filter_map(|(network, maybe_freq)| {
            maybe_freq.map(|freq_model| {
                (freq_model.freq.clone(), network.name.clone())
            })
        })
        .collect();

    // Pre-load callsigns
    #[derive(FromQueryResult)]
    struct CallsignRes {
        freq: String,
        callsign: String,
    }

    let callsigns: HashMap<String, Vec<String>> =
        signal_message::Entity::find()
            .join(
                JoinType::InnerJoin,
                signal_message::Relation::SigintInboxItem.def(),
            )
            .select_only()
            .column_as(sigint_inbox_item::Column::Freq, "freq")
            .column_as(
                Expr::cust("jsonb_array_elements_text(callsigns)"),
                "callsign",
            )
            .filter(sigint_inbox_item::Column::Freq.is_in(unique_freqs.clone()))
            .filter(sigint_inbox_item::Column::Datetime.gte(dt_since_minus_24h))
            .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
            .filter(signal_message::Column::Deleted.eq(false))
            .group_by(Expr::cust("1, 2"))
            .into_model::<CallsignRes>()
            .all(&env.dbx)
            .await
            .context(h!())?
            .into_iter()
            .fold(HashMap::new(), |mut acc, row| {
                let entry = acc.entry(row.freq).or_default();
                if entry.len() < 10 {
                    entry.push(row.callsign);
                }
                acc
            });

    let mut features = HashMap::new();

    for item in items.iter() {
        let Some(freq) = item.freq.clone() else {
            continue;
        };
        let Some(lat) = item.lat else {
            continue;
        };
        let Some(lng) = item.lng else {
            continue;
        };

        let mut comments = vec![];

        if let Some(network_name) = networks.get(&freq) {
            comments.push(format!("Мережа: {network_name}"));
        }

        let callsigns_s = callsigns
            .get(&freq)
            .map(|v| v.join(", "))
            .unwrap_or_default();
        comments.push(format!("Позивні: {callsigns_s}"));

        let mut comments_one: String = comments.join("\n");
        comments_one.push_str(&format!("\n\nГрупа: {}", &item.group_name));

        let tz = crate::config::get_tz();
        // convert NaiveDateTime in UTC to NaiveDateTime in local timezone
        let datetime_utc = tz.from_utc_datetime(&item.datetime);
        let properties = crate::delta::types::Properties {
            name: Some(freq.clone()),
            sidc: "10061500002001000000".to_string(),
            comments: vec![comments_one],
            // like "2023-06-06T13:20:12"
            observation_datetime: Some(
                datetime_utc.format("%Y-%m-%dT%H:%M:%S").to_string(),
            ),
        };
        let feature = crate::delta::types::Feature {
            type_: "Feature".to_string(),
            geometry: crate::delta::types::Geometry {
                type_: "Point".to_string(),
                coordinates: serde_json::to_value(vec![lng, lat])
                    .context(h!())?,
            },
            properties: Some(properties),
        };

        let key = (
            freq.clone(),
            datetime_utc,
            format!("{lng:.6}"),
            format!("{lat:.6}"),
        );
        features.entry(key).or_insert(feature);
    }

    let geojson = GeoJson {
        type_: "FeatureCollection".to_string(),
        features: features.values().cloned().collect(),
    };
    let geojson = serde_json::to_string(&geojson).context(h!())?;
    std::fs::write(&outpath, geojson)?;

    let file = actix_files::NamedFile::open_async(&outpath).await?;
    Ok(file.into_response(&http_req))
}
