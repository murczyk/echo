use super::*;
use crate::types::ShortContext;
use crate::users::get_organism_login_ids_by_id;
use tempfile::TempDir;

#[derive(FromQueryResult)]
struct KmzReportItem {
    id: i64,
    freq: Option<String>,
    lat: Option<f64>,
    lng: Option<f64>,
    body: Option<String>,
}

pub(crate) async fn rer_analysis_kmz_bytes(
    login: &uuid::Uuid,
    env: &Env,
    req: super::AnalysisStatsReq,
) -> Result<Vec<u8>, AppError> {
    let sigint_groups =
        crate::messenger::group::get_identity_sigint_groups(&env.dbx, login)
            .await
            .c(h!())?;
    let report_settings =
        crate::system_settings::get_report_generation_settings(&env.dbx)
            .await
            .c(h!())?;
    let chunks = report_period_chunks(
        req.since_date_inclusive_ms,
        req.till_date_noninclusive_ms,
        report_settings.chunking_hours,
        ReportPeriodEnd::NonInclusive,
    )
    .context(h!())?;
    let mut items = BTreeMap::new();
    for (index, chunk) in chunks.iter().copied().enumerate() {
        info!(
            "KMZ report chunk {}/{}: {}..{}",
            index + 1,
            chunks.len(),
            chunk.since_ms,
            chunk.till_ms
        );
        for item in load_kmz_report_items(
            login,
            env,
            &req,
            &sigint_groups,
            dt_from_millis(chunk.since_ms).context(h!())?,
            dt_from_millis(chunk.till_ms).context(h!())?,
        )
        .await
        .context(h!())?
        {
            items.entry(item.id).or_insert(item);
        }
    }
    let items = items.into_values().collect::<Vec<_>>();

    let tmp_dir = TempDir::new().context(h!())?;
    // let outpath = tmp_dir.path().join("summary-table.kmz");

    let sidc = "10061000001110010000".to_string();
    // let res = crate::kml::build_style_maps_per_app6d(&vec![sidc.clone()])?;

    let mut nodes = vec![];
    let login_ids = get_organism_login_ids_by_id(&env.dbx, login)
        .await
        .c(h!())?;
    for item in items.iter() {
        let Some(ref freq) = item.freq else { continue };
        let Some(ref lat) = item.lat else { continue };
        let Some(ref lng) = item.lng else { continue };
        let m_comment = crate::sigint::comments::find_report_comments(
            &env.dbx,
            &[item.id],
            Some(&login_ids),
        )
        .await
        .c(h!())?
        .into_iter()
        .filter(|comment| comment.post_id.is_none())
        .next();

        let icon_href = format!(
            "https://f000.backblazeb2.com/file/wildducks-online-public/icons/{sidc}.png",
        );
        nodes.push(Node::Placemark(Placemark {
            name: Some(freq.clone()),
            visibility: None,
            snippet: None,
            snippet_lower: None,
            description: Some(format!(
                "{}<br>\n<br>\n{}<br>\n<br>\n",
                item.body.clone().unwrap_or("".to_string()),
                m_comment
                    .map(|x| format!("Коментар: {}", x.comment))
                    .unwrap_or("".to_string())
            )),
            style: Some(Style {
                icon_style: Some(IconStyle {
                    color: None,
                    scale: None,
                    icon: Some(Icon {
                        href: Some(Href {
                            body: Some(icon_href),
                        }),
                    }),
                }),
                id: None,
                label_style: None,
                balloon_style: None,
                line_style: None,
                poly_style: None,
            }),
            // style: None,
            style_url: None,
            // style_url: Some(StyleUrl {
            //     body: format!("map-{}", &sidc),
            // }),
            point: Some(Point {
                draw_order: None,
                coordinates: Some(format!("{lng},{lat},0")),
            }),
            line_string: None,
            multi_geometry: None,
            polygon: None,
            extended_data: None,
        }));
    }

    let now = Utc::now();
    let now_s = format!("{}-{:02}-{:02}", now.year(), now.month(), now.day());
    let root_folder = Folder {
        name: Some(Name {
            body: format!("rer-{now_s}"),
        }),
        look_at: None,
        description: None,
        open: None,
        // styles: res.styles,
        // style_maps: res.style_maps,
        styles: vec![],
        style_maps: vec![],
        visibility: None,
        snippet: None,
        snippet_lower: None,
        link: None,
        camera: None,
        gx_balloon_visibility: None,
        schema: vec![],
        nodes,
    };
    let kml = Kml {
        nodes: vec![Node::Folder(root_folder)],
    };
    let outpath =
        crate::importer::package_up_kmz2(&env.config, &tmp_dir, &kml)?;
    let bytes = tokio::fs::read(&outpath).await.c(h!())?;
    Ok(bytes)
}

async fn load_kmz_report_items(
    login: &uuid::Uuid,
    env: &Env,
    req: &AnalysisStatsReq,
    sigint_groups: &[String],
    dt_since: NaiveDateTime,
    dt_till: NaiveDateTime,
) -> Result<Vec<KmzReportItem>, AppError> {
    let items = signal_message::Entity::find()
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::SigintInboxItem.def(),
        )
        .join(
            JoinType::LeftJoin,
            sigint_inbox_item::Relation::SigintPost.def(),
        )
        .join(
            JoinType::InnerJoin,
            signal_message::Relation::DatasourceGroup.def(),
        )
        .select_only()
        .column_as(sigint_inbox_item::Column::Id, "id")
        .column_as(Expr::col(sigint_inbox_item::Column::Freq), "freq")
        .column_as(Expr::col(signal_message::Column::Body), "body")
        .column_as(Expr::col(sigint_inbox_item::Column::Lat), "lat")
        .column_as(Expr::col(sigint_inbox_item::Column::Lng), "lng")
        .filter(
            datasource_group::Column::GroupMasterKey
                .eq_any(sigint_groups.to_vec()),
        )
        .filter(signal_message::Column::Deleted.eq(false))
        .filter(sigint_inbox_item::Column::Datetime.gte(dt_since))
        .filter(sigint_inbox_item::Column::Datetime.lt(dt_till))
        .filter(sigint_inbox_item::Column::Lat.is_not_null())
        .filter(sigint_inbox_item::Column::Lng.is_not_null());
    let items =
        filter_selected_freqs(items, &req.selected_freqs).context(h!())?;
    let items =
        filter_selected_posts(items, &req.selected_posts).context(h!())?;
    let items = filter_selected_groups_and_senders_with_access(
        items,
        &req.selected_groups,
        &req.selected_senders,
        sigint_groups,
    )
    .context(h!())?;
    let items = filter_selected_units(
        items,
        &req.selected_units,
        &req.units_exact_match_only,
    )
    .context(h!())?;
    let items = filter_selected_callsigns(items, &req.selected_callsigns)
        .context(h!())?;
    let items = filter_selected_tags(
        items,
        &req.selected_tags,
        &req.denied_tags,
        &req.tag_presence,
        &req.or_bookmarked,
        &req.or_important,
        &req.or_with_coords,
        &req.or_without_coords,
        &req.or_with_extended_form,
        &req.filter_tags_option,
        &req.without_model_tags,
        login,
        req.report_tags_only_this_unit.unwrap_or(false),
    )
    .context(h!())?;
    let items =
        filter_selected_aors(items, &req.selected_aors).context(h!())?;
    let items = filter_selected_networks(
        items,
        &req.selected_networks,
        &req.without_network,
    )
    .context(h!())?;
    let items = filter_selected_metadata_for_analysis_stats(items, req)
        .context(h!())?;
    let items = filter_search(items, &req.search).context(h!())?;
    let items = filter_selected_device_names(items, &req.selected_device_names)
        .context(h!())?;
    let items = items.group_by(Expr::cust("1, 2, 3"));
    // println!(
    //     "> download kmz items query: {}",
    //     items.build(DbBackend::Postgres).to_string()
    // );
    Ok(items
        .into_model::<KmzReportItem>()
        .all(&env.dbx)
        .await
        .c(h!())?)
}
