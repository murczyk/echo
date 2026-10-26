use super::*;
use crate::functest::tests::*;
use sea_orm::ActiveValue::Set;
use serial_test::serial;
use std::io::Read;

async fn seed_message(
    db: &DatabaseConnection,
    group: &datasource_group::Model,
    timestamp: NaiveDateTime,
    freq: &str,
    network_ids: &[i64],
) -> anyhow::Result<i64> {
    let message = mk_signal_message(
        db,
        signal_message::ActiveModel {
            timestamp: Set(Some(timestamp)),
            datasource_group_id: Set(Some(group.id)),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    mk_signal_message_group(
        db,
        signal_message_group::ActiveModel {
            signal_message_id: Set(message.id),
            group_master_key: Set(Some(group.group_master_key.clone())),
            datasource_group_id: Set(Some(group.id)),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    mk_sigint_inbox_item(
        db,
        sigint_inbox_item::ActiveModel {
            id: Set(message.id),
            datetime: Set(Some(timestamp)),
            freq: Set(Some(freq.to_string())),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    for network_id in network_ids {
        mk_sigint_inbox_item_network(
            db,
            sigint_inbox_item_network::ActiveModel {
                sigint_inbox_item_id: Set(message.id),
                sigint_network_id: Set(*network_id),
                ..Default::default()
            },
        )
        .await
        .c(h!())?;
    }
    Ok(message.id)
}

fn activity_snapshot(
    report: &Report,
) -> Vec<(String, Vec<String>, NaiveDateTime, NaiveDateTime, u64)> {
    let mut rows = report
        .hostile_networks
        .iter()
        .chain(&report.undefined_networks)
        .map(|row| {
            (
                row.name.clone(),
                row.freqs.clone(),
                row.activity.since,
                row.activity.till,
                row.activity.seances_qty,
            )
        })
        .collect::<Vec<_>>();
    rows.sort();
    rows
}

#[tokio::test]
#[serial]
async fn issue_3864_summary_keeps_full_report_activity_across_chunks(
) -> anyhow::Result<()> {
    let (env, _guard) = cleanup_locked().await.c(h!())?;
    let db = &env.dbx;
    let login = find_test_login(db).await.c(h!())?;
    let group = find_test_datasource_group(db).await.c(h!())?;
    let network = mk_sigint_network(
        db,
        sigint_network::ActiveModel {
            name: Set("Мережа 3864".to_string()),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    let unit = mk_sigint_unit(
        db,
        sigint_unit::ActiveModel {
            name: Set("Підрозділ 3864".to_string()),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    mk_sigint_network_unit(
        db,
        sigint_network_unit::ActiveModel {
            network_id: Set(network.id),
            unit_id: Set(unit.id),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    let other_network = mk_sigint_network(
        db,
        sigint_network::ActiveModel {
            name: Set("Мережа 3864 друга".to_string()),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    let since = NaiveDate::from_ymd_opt(2026, 10, 24)
        .unwrap()
        .and_hms_opt(8, 0, 0)
        .unwrap();
    seed_message(db, &group, since, "123.400", &[network.id])
        .await
        .c(h!())?;
    seed_message(
        db,
        &group,
        since + chrono::Duration::hours(1),
        "123.400",
        &[network.id, other_network.id],
    )
    .await
    .c(h!())?;
    seed_message(
        db,
        &group,
        since + chrono::Duration::hours(2),
        "456.700",
        &[],
    )
    .await
    .c(h!())?;
    seed_message(
        db,
        &group,
        since - chrono::Duration::seconds(1),
        "123.400",
        &[network.id],
    )
    .await
    .c(h!())?;
    let peleng = seed_message(
        db,
        &group,
        since + chrono::Duration::minutes(30),
        "123.400",
        &[network.id],
    )
    .await
    .c(h!())?;
    let linked_peleng = seed_message(
        db,
        &group,
        since + chrono::Duration::minutes(40),
        "123.400",
        &[network.id],
    )
    .await
    .c(h!())?;
    let comment = seed_message(
        db,
        &group,
        since + chrono::Duration::minutes(45),
        "123.400",
        &[network.id],
    )
    .await
    .c(h!())?;
    signal_message::Entity::update_many()
        .col_expr(signal_message::Column::Body, Expr::value("Донесення 3864"))
        .col_expr(signal_message::Column::LoginId, Expr::value(login.id))
        .filter(signal_message::Column::Id.eq(comment))
        .exec(db)
        .await
        .c(h!())?;
    intel_product::ActiveModel {
        source_message_id: Set(linked_peleng),
        intel_message_id: Set(comment),
        relation_kind: Set(crate::entities::sea_orm_active_enums::IntelProductRelationKind::Comment),
        created_at: Set(since),
        ..Default::default()
    }.insert(db).await.c(h!())?;
    sigint_inbox_item::Entity::update_many()
        .col_expr(
            sigint_inbox_item::Column::Coords,
            Expr::value("36U 12345 67890"),
        )
        .col_expr(
            sigint_inbox_item::Column::CallsignTokens,
            Expr::value(serde_json::json!([])),
        )
        .filter(sigint_inbox_item::Column::Id.is_in([peleng, linked_peleng]))
        .exec(db)
        .await
        .c(h!())?;
    mk_sigint_comment(
        db,
        sigint_comment::ActiveModel {
            signal_message_id: Set(peleng),
            login_id: Set(login.id),
            comment: Set("Коментар 3864".to_string()),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    let req = InboxMessagesReq {
        since_date_inclusive_ms: Some(since.and_utc().timestamp_millis()),
        till_date_inclusive_ms: Some(
            (since + chrono::Duration::hours(2))
                .and_utc()
                .timestamp_millis(),
        ),
        selected_groups: Some(vec![group.group_master_key.clone()]),
        nolimit: Some(true),
        ..Default::default()
    };
    let chunks = inbox_report_period_chunks(&req, 1).c(h!())?;
    let logins = crate::users::get_organism_login_ids_by_id(db, &login.id)
        .await
        .c(h!())?;
    for no_comments in [false, true] {
        let messages =
            load_reo_inbox_messages_chunks(db, &login.id, &env, &req, &chunks)
                .await
                .c(h!())?;
        let full = collect_report(
            messages,
            logins.clone(),
            &env,
            db,
            0.0,
            &None,
            true,
            no_comments,
        )
        .await
        .c(h!())?;
        let messages =
            load_summary_messages(&login.id, &env, &req, no_comments, true)
                .await
                .c(h!())?;
        assert_eq!(messages.len(), 3);
        assert!(messages
            .iter()
            .all(|(_, message)| message.callsigns.is_empty()
                && message.callsign_tokens.is_empty()));
        let summary = collect_report(
            messages,
            logins.clone(),
            &env,
            db,
            0.0,
            &None,
            true,
            true,
        )
        .await
        .c(h!())?;
        assert_eq!(activity_snapshot(&summary), activity_snapshot(&full));
        assert_eq!(summary.summary.identified_qty, full.summary.identified_qty);
        assert_eq!(
            summary.summary.unidentified_qty,
            full.summary.unidentified_qty
        );
        let network = summary
            .hostile_networks
            .iter()
            .find(|row| row.name.starts_with("Мережа 3864 Підрозділ"))
            .unwrap();
        assert_eq!(
            network.activity.seances_qty,
            if no_comments { 2 } else { 4 }
        );
    }
    Ok(())
}

#[tokio::test]
#[serial]
async fn issue_3889_long_summary_merges_weekly_activity_into_report_files(
) -> anyhow::Result<()> {
    let (env, _guard) = cleanup_locked().await.c(h!())?;
    let db = &env.dbx;
    let login = find_test_login(db).await.c(h!())?;
    let group = find_test_datasource_group(db).await.c(h!())?;
    let network = mk_sigint_network(
        db,
        sigint_network::ActiveModel {
            name: Set("Мережа 3889".to_string()),
            ..Default::default()
        },
    )
    .await
    .c(h!())?;
    system_settings::ActiveModel {
        report_chunking_hours: Set(1),
        limit_big_reports: Set(true),
        ..Default::default()
    }
    .insert(db)
    .await
    .c(h!())?;
    let since = NaiveDate::from_ymd_opt(2025, 8, 30)
        .unwrap()
        .and_hms_opt(8, 0, 0)
        .unwrap();
    let till = since + chrono::Duration::weeks(60) + chrono::Duration::hours(1);
    for timestamp in [
        since,
        since + chrono::Duration::weeks(1),
        since + chrono::Duration::weeks(2),
        till,
        since - chrono::Duration::milliseconds(1),
        till + chrono::Duration::milliseconds(1),
    ] {
        seed_message(db, &group, timestamp, "123.400", &[network.id])
            .await
            .c(h!())?;
    }
    for timestamp in [since + chrono::Duration::weeks(1), till] {
        seed_message(db, &group, timestamp, "456.700", &[])
            .await
            .c(h!())?;
    }
    let req = InboxMessagesReq {
        since_date_inclusive_ms: Some(since.and_utc().timestamp_millis()),
        till_date_inclusive_ms: Some(till.and_utc().timestamp_millis()),
        selected_groups: Some(vec![group.group_master_key.clone()]),
        nolimit: Some(true),
        ..Default::default()
    };
    let error =
        load_reo_report_messages(&login.id, &env, &req, false, true, false)
            .await
            .unwrap_err();
    assert!(
        format!("{error:?}").contains("Період звіту утворює забагато частин")
    );
    let messages =
        load_reo_report_messages(&login.id, &env, &req, true, true, false)
            .await
            .c(h!())?;
    assert_eq!(messages.len(), 2);
    for (_, message) in &messages {
        let activity = message.activity.as_ref().unwrap();
        let expected_since = if message.network_ids.is_some() {
            assert_eq!(activity.seances_qty, 4);
            since
        } else {
            assert_eq!(activity.seances_qty, 2);
            since + chrono::Duration::weeks(1)
        };
        let local_time = |timestamp: NaiveDateTime| {
            timestamp
                .and_utc()
                .with_timezone(&crate::config::get_tz())
                .naive_local()
        };
        assert_eq!(activity.since, local_time(expected_since));
        assert_eq!(activity.till, local_time(till));
    }
    for file_type in [ReoReportFileType::Docx, ReoReportFileType::Xlsx] {
        let is_docx = file_type == ReoReportFileType::Docx;
        let req: ReportPreviewReq = serde_json::from_value(serde_json::json!({
            "kind": "reo",
            "req": req,
            "report_type": ReportType::Reo(ReoReportSettings {
                adjacent_freqs_distance: 0.0,
                no_comments: true,
                summary_only: true,
            }, file_type),
        }))
        .c(h!())?;
        let output = tempfile::NamedTempFile::new().c(h!())?;
        report_docx_kind_reo(&login.id, &env, &req, output.path())
            .await
            .c(h!())?;
        let xml = archive_xml(
            output.path(),
            if is_docx {
                "word/document.xml"
            } else {
                "xl/sharedStrings.xml"
            },
        );
        assert!(xml.contains("Мережа 3889"));
        assert!(xml.contains("123.400"));
        assert!(xml.contains("456.700"));
        if is_docx {
            assert!(xml.contains("Сеанси: 4"));
            assert!(xml.contains("Сеанси: 2"));
        }
    }
    Ok(())
}

fn sample_report() -> Report {
    let since = NaiveDate::from_ymd_opt(2026, 10, 24)
        .unwrap()
        .and_hms_opt(8, 0, 0)
        .unwrap();
    let row = |name: &str| NetworkRow {
        name: name.to_string(),
        location: Some("Локація 3864".to_string()),
        freqs: vec!["123.400".to_string()],
        activity: NetworkActivity {
            since,
            till: since + chrono::Duration::hours(1),
            seances_qty: 42,
        },
        correspondents: vec![NetworkCorrespondent {
            callsign: "ПОЗИВНИЙ3864".to_string(),
            position: None,
        }],
        communication_kind: None,
        functionality_details: FUNCTIONALITY_DESC_DEFAULT.to_string(),
        identified_details: vec!["КОМЕНТАР3864".to_string()],
    };
    Report {
        summary: ReportSummary {
            identified_qty: 1,
            unidentified_qty: 1,
        },
        hostile_networks: vec![row("Прив’язана 3864")],
        undefined_networks: vec![row("Неприв’язана 3864")],
    }
}

fn archive_xml(path: &Path, entry: &str) -> String {
    let mut archive =
        ::zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut xml = String::new();
    archive
        .by_name(entry)
        .unwrap()
        .read_to_string(&mut xml)
        .unwrap();
    xml
}

#[test]
fn issue_3864_summary_omits_detail_columns_in_docx_and_xlsx(
) -> anyhow::Result<()> {
    for summary_only in [false, true] {
        for no_comments in [false, true] {
            let docx = tempfile::NamedTempFile::new().c(h!())?;
            generate_docx_kind_reo(
                sample_report(),
                "Підсумок 3864".to_string(),
                docx.path(),
                no_comments,
                summary_only,
            )
            .c(h!())?;
            let xml = archive_xml(docx.path(), "word/document.xml");
            assert!(xml.contains("Сеанси: 42"));
            assert!(xml.contains("Прив’язана 3864"));
            assert!(xml.contains("Неприв’язана 3864"));
            assert!(xml.contains("123.400"));
            assert_eq!(xml.contains("ПОЗИВНИЙ3864"), !summary_only);
            assert_eq!(
                xml.contains(
                    "Склад кореспондентів радіомережі та приналежність"
                ),
                !summary_only
            );
            assert_eq!(
                xml.contains("Що було виявлено"),
                !no_comments && !summary_only
            );
            assert_eq!(
                xml.contains("КОМЕНТАР3864"),
                !no_comments && !summary_only
            );
            let xlsx = tempfile::NamedTempFile::new().c(h!())?;
            generate_xlsx_kind_reo(
                sample_report(),
                "Підсумок 3864".to_string(),
                xlsx.path(),
                no_comments,
                summary_only,
            )
            .c(h!())?;
            let xml = archive_xml(xlsx.path(), "xl/sharedStrings.xml");
            assert!(xml.contains("Сеанси"));
            assert!(xml.contains("Прив’язана 3864"));
            assert!(xml.contains("Неприв’язана 3864"));
            assert!(xml.contains("123.400"));
            assert_eq!(xml.contains("ПОЗИВНИЙ3864"), !summary_only);
            assert_eq!(
                xml.contains(
                    "Склад кореспондентів радіомережі та приналежність"
                ),
                !summary_only
            );
            assert_eq!(
                xml.contains("Що було виявлено"),
                !no_comments && !summary_only
            );
            assert_eq!(
                xml.contains("КОМЕНТАР3864"),
                !no_comments && !summary_only
            );
        }
    }
    Ok(())
}

#[tokio::test]
#[serial]
#[ignore]
async fn issue_3864_summary_query_plan_at_scale() -> anyhow::Result<()> {
    let (env, _guard) = cleanup_locked().await.c(h!())?;
    let login = find_test_login(&env.dbx).await.c(h!())?;
    let group = find_test_datasource_group(&env.dbx).await.c(h!())?;
    let network = mk_sigint_network(&env.dbx, Default::default())
        .await
        .c(h!())?;
    let db = env.dbx.begin().await.c(h!())?;
    db.execute_unprepared("set local statement_timeout = '60s'")
        .await
        .c(h!())?;
    db.execute_raw(Statement::from_sql_and_values(DbBackend::Postgres, r#"
        with messages as (
            insert into signal_message (body, timestamp, datasource_group_id)
            select repeat('Перехоплення ', 100),
                   timestamp '2026-10-24 08:00:00' + (n % 7200) * interval '1 second', $1
            from generate_series(1, 100000) n
            returning id, timestamp
        ), items as (
            insert into sigint_inbox_item (id, datetime, freq)
            select id, timestamp, (123.4 + (id % 10)::numeric / 10)::text from messages
            returning id
        ), groups as (
            insert into signal_message_group (signal_message_id, group_master_key, datasource_group_id)
            select id, $2, $1 from messages
        )
        insert into sigint_inbox_item_network (sigint_inbox_item_id, sigint_network_id)
        select id, $3 from items where id % 2 = 0
    "#, [group.id.into(), group.group_master_key.clone().into(), network.id.into()]))
        .await.c(h!())?;
    for table in [
        "signal_message",
        "sigint_inbox_item",
        "signal_message_group",
        "sigint_inbox_item_network",
    ] {
        db.execute_unprepared(&format!("analyze {table}"))
            .await
            .c(h!())?;
    }
    let req = InboxMessagesReq {
        since_date_inclusive_ms: Some(
            NaiveDate::from_ymd_opt(2026, 10, 24)
                .unwrap()
                .and_hms_opt(8, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis(),
        ),
        till_date_inclusive_ms: Some(
            NaiveDate::from_ymd_opt(2026, 10, 24)
                .unwrap()
                .and_hms_opt(10, 0, 0)
                .unwrap()
                .and_utc()
                .timestamp_millis(),
        ),
        selected_groups: Some(vec![group.group_master_key.clone()]),
        nolimit: Some(true),
        ..Default::default()
    };
    let groups =
        crate::messenger::group::get_identity_sigint_groups(&db, &login.id)
            .await
            .c(h!())?;
    let query = build_filtered_inbox_report_chunk_query(
        &db,
        &login.id,
        &env,
        &req,
        ReportPeriodEnd::Inclusive,
    )
    .await
    .c(h!())?;
    let query = activity_query(
        query,
        first_group(&req, groups),
        activity_eligible(false, None),
    );
    let statement = query.build(DbBackend::Postgres);
    let plan = db
        .query_all_raw(Statement::from_sql_and_values(
            DbBackend::Postgres,
            format!(
                "explain (analyze, buffers, timing off, summary on) {}",
                statement.sql
            ),
            statement.values.map(|values| values.0).unwrap_or_default(),
        ))
        .await
        .c(h!())?;
    for row in plan {
        println!("{}", row.try_get_by_index::<String>(0).c(h!())?);
    }
    let rows = query.into_model::<ActivityRow>().all(&db).await.c(h!())?;
    assert_eq!(rows.len(), 10);
    assert_eq!(rows.iter().map(|row| row.seances_qty).sum::<i64>(), 100000);
    db.rollback().await.c(h!())?;
    Ok(())
}
