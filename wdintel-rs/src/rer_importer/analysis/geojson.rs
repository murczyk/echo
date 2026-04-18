use super::*;
use crate::types::ShortContext;
use crate::utils::orm::ArrayColumnOps;
use actix_web::post;
use chrono_tz::Tz;
use std::collections::HashMap;
use tempfile::TempDir;

const GEOJSON_COMMENT_MAX_LEN: usize = 2000;

fn split_geojson_comment(comment: &str) -> Vec<String> {
    if comment.chars().count() <= GEOJSON_COMMENT_MAX_LEN {
        return vec![comment.to_string()];
    }

    let mut chunks = Vec::new();
    let mut remaining = comment;

    while remaining.chars().count() > GEOJSON_COMMENT_MAX_LEN {
        let split_at = split_geojson_comment_index(remaining);
        let (head, tail) = remaining.split_at(split_at);
        chunks.push(head.to_string());
        remaining = trim_leading_newline(tail);
    }

    if !remaining.is_empty() {
        chunks.push(remaining.to_string());
    }

    chunks
}

fn split_geojson_comment_index(comment: &str) -> usize {
    let mut last_newline_idx = None;

    for (char_count, (byte_idx, ch)) in comment.char_indices().enumerate() {
        if char_count == GEOJSON_COMMENT_MAX_LEN {
            return last_newline_idx.unwrap_or(byte_idx);
        }
        if ch == '\n' {
            last_newline_idx = Some(byte_idx);
        }
    }

    comment.len()
}

fn trim_leading_newline(comment: &str) -> &str {
    comment.strip_prefix('\n').unwrap_or(comment)
}

/// Summary table showing row-per-frequency
#[post("/api/rer/analysis/download-geojson")]
pub async fn rer_analysis_download_geojson(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<AnalysisStatsReq>,
    http_req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login.clone(), "Rer")
        .await
        .c(h!())?;
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
        body: Option<String>,
    }
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, &login)
            .await
            .c(h!())?;
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
        .column_as(sigint_inbox_item::Column::Id, "id")
        .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
        .column_as(signal_group::Column::Name, "group_name")
        .column_as(Expr::col(sigint_inbox_item::Column::Lat), "lat")
        .column_as(Expr::col(sigint_inbox_item::Column::Lng), "lng")
        .column_as(sigint_inbox_item::Column::Datetime, "datetime")
        .column_as(Expr::col(signal_message::Column::Body), "body")
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(sigint_groups.clone()),
        )
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(sigint_inbox_item::Column::Lat.is_not_null())
        .filter(sigint_inbox_item::Column::Lng.is_not_null());
    let items = filter_selected_freqs(items, &req.selected_freqs)?;
    let items = filter_selected_posts(items, &req.selected_posts)?;
    let items = filter_selected_groups_and_senders_with_access(
        items,
        &req.selected_groups,
        &req.selected_senders,
        &sigint_groups,
    )?;
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
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        &user.id().c(h!())?,
        req.report_tags_only_this_unit.unwrap_or(false),
    )?;
    let items =
        filter_selected_aors(items, &req.selected_aors).context(h!())?;
    let items = filter_selected_networks(
        items,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let items = filter_selected_metadata_for_analysis_stats(items, &req)?;
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
    let items = items.into_model::<Res>().all(&env.dbx).await.c(h!())?;
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

    let unique_freqs: Vec<String> = unique_freqs.into_iter().collect();
    // Pre-load networks
    let networks: HashMap<String, String> = sigint_network::Entity::find()
        .find_also_related(sigint_network_freq::Entity)
        .filter(sigint_network::Column::Deleted.eq(false))
        .filter(filter_active_ts)
        .filter(sigint_network_freq::Column::Freq.eq_any(unique_freqs.clone()))
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
            .filter(
                sigint_inbox_item::Column::Freq.eq_any(unique_freqs.clone()),
            )
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

    let mut features: HashMap<
        (String, DateTime<Tz>, String, String),
        crate::delta::types::Feature,
    > = HashMap::new();

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
        if let Some(body) = item.body.as_ref().filter(|body| !body.is_empty()) {
            comments_one.push_str(&format!("\n\nПовідомлення: {body}"));
        }

        let tz = crate::config::get_tz();
        // convert NaiveDateTime in UTC to NaiveDateTime in local timezone
        let datetime_utc = tz.from_utc_datetime(&item.datetime);
        let properties = crate::delta::types::Properties {
            name: Some(freq.clone()),
            sidc: "10061500002001000000".to_string(),
            comments: split_geojson_comment(&comments_one),
            // like "2023-06-06T13:20:12"
            observation_datetime: Some(
                datetime_utc.format("%Y-%m-%dT%H:%M:%S").to_string(),
            ),
        };
        let key = (
            freq.clone(),
            datetime_utc,
            format!("{lng:.6}"),
            format!("{lat:.6}"),
        );
        match features.entry(key) {
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                if let Some(properties) = entry.get_mut().properties.as_mut() {
                    properties
                        .comments
                        .extend(split_geojson_comment(&comments_one));
                }
            }
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(crate::delta::types::Feature {
                    type_: "Feature".to_string(),
                    geometry: crate::delta::types::Geometry {
                        type_: "Point".to_string(),
                        coordinates: serde_json::to_value(vec![lng, lat])
                            .context(h!())?,
                    },
                    properties: Some(properties),
                });
            }
        }
    }

    let geojson = GeoJson {
        type_: "FeatureCollection".to_string(),
        features: features.values().cloned().collect(),
    };
    let geojson = serde_json::to_string(&geojson).context(h!())?;
    std::fs::write(&outpath, geojson)?;

    let file = actix_files::NamedFile::open_async(&outpath).await.c(h!())?;
    Ok(file.into_response(&http_req))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_geojson_comment_keeps_short_comment() {
        assert_eq!(
            split_geojson_comment("short comment"),
            vec!["short comment".to_string()]
        );
    }

    #[test]
    fn split_geojson_comment_splits_on_last_newline_before_limit() {
        let first = "a".repeat(1500);
        let second = "b".repeat(700);
        let comment = format!("{first}\n{second}");

        assert_eq!(split_geojson_comment(&comment), vec![first, second]);
    }

    #[test]
    fn split_geojson_comment_splits_long_line_at_limit() {
        let comment = "x".repeat(GEOJSON_COMMENT_MAX_LEN + 10);
        let chunks = split_geojson_comment(&comment);

        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].chars().count(), GEOJSON_COMMENT_MAX_LEN);
        assert_eq!(chunks[1].chars().count(), 10);
    }
}
