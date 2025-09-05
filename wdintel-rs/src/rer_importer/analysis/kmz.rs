use super::*;
use actix_web::post;
use tempfile::TempDir;

/// Summary table showing row-per-frequency
#[post("/api/rer/analysis/download-kmz")]
pub async fn rer_analysis_download_kmz(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    req: Json<super::AnalysisStatsReq>,
    http_req: HttpRequest,
) -> Result<HttpResponse, AppError> {
    let login = user.id()?;
    crate::users::has_role(&env.dbx, &login, "Rer").await?;
    let dt_since = dt_from_millis(req.since_date_inclusive_ms)?;
    let dt_till = dt_from_millis(req.till_date_noninclusive_ms)?;

    #[derive(FromQueryResult)]
    struct Res {
        id: i64,
        freq: Option<String>,
        lat: Option<f64>,
        lng: Option<f64>,
        body: Option<String>,
    }
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
        .filter(datasource_group::Column::GroupMasterKey.is_in(
            crate::users::get_identity_sigint_groups(&env.dbx, &login).await?,
        ))
        .filter(signal_message::Column::Deleted.eq(false))
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
    let items = items.group_by(Expr::cust("1, 2, 3"));
    // println!(
    //     "> download kmz items query: {}",
    //     items.build(DbBackend::Postgres).to_string()
    // );
    let items = items.into_model::<Res>().all(&env.dbx).await?;

    let tmp_dir = TempDir::new()?;
    // let outpath = tmp_dir.path().join("summary-table.kmz");

    let sidc = "10061000001110010000".to_string();
    // let res = crate::kml::build_style_maps_per_app6d(&vec![sidc.clone()])?;

    let mut nodes = vec![];
    let logins = crate::users::get_organism_logins(&env.dbx, user).await?;
    for item in items.iter() {
        let Some(ref freq) = item.freq else { continue };
        let Some(ref lat) = item.lat else { continue };
        let Some(ref lng) = item.lng else { continue };
        let m_comment = sigint_comment::Entity::find()
            .filter(sigint_comment::Column::SignalMessageId.eq(item.id))
            .filter(sigint_comment::Column::Login.is_in(logins.clone()))
            .one(&env.dbx)
            .await?;
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
                    .map(|x| x.comment)
                    .clone()
                    .map(|x| format!("Коментар: {x}"))
                    .unwrap_or("".to_string())
            )),
            style: Some(Style {
                icon_style: Some(IconStyle {
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
    let file = actix_files::NamedFile::open_async(&outpath).await?;
    Ok(file.into_response(&http_req))
}
