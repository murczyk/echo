use super::rules::{
    analyze, compile_tag_rules, deserialize_rule_expression,
    test_rule_expression,
};
use super::types::{
    FileAnalysisInput, RuleExpression, RuleField, RuleMatcher, RuleTestFile,
    TagRuleDefinition,
};
use super::{bl, query, queue, worker};
use crate::devices::files::types::RawSyncDeviceFileItem;
use crate::devices::{access, ROLE_DEVICE_SOURCE};
use crate::entities::{device, login, organism};
use crate::file_registry::entities::{
    device_file_tag, file_analysis_definition, file_analysis_run,
    file_analysis_run_item, file_entry, file_revision, file_sync_session,
    sea_orm_active_enums::{
        FileEntryKind, FileSyncSessionMode, FileSyncSessionStatus,
    },
};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::types::Env;
use chrono::{Duration as ChronoDuration, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
    IntoActiveModel, PaginatorTrait, QueryFilter, QueryOrder,
};
use serde_json::json;
use uuid::Uuid;

fn file<'a>(
    name: &'a str,
    absolute_path: &'a str,
    extension: Option<&'a str>,
) -> FileAnalysisInput<'a> {
    FileAnalysisInput {
        name,
        absolute_path,
        extension,
    }
}

fn condition(
    field: RuleField,
    matcher: RuleMatcher,
    values: &[&str],
) -> RuleExpression {
    RuleExpression::Match {
        field,
        matcher,
        values: values.iter().map(|value| (*value).to_string()).collect(),
    }
}

#[test]
fn filename_excludes_the_last_suffix_and_extension_uses_the_complete_value() {
    let expression = RuleExpression::RuleAll {
        children: vec![
            condition(
                RuleField::FileName,
                RuleMatcher::Equals,
                &["звіт.final"],
            ),
            condition(RuleField::Extension, RuleMatcher::Equals, &["tar.gz"]),
        ],
    };

    assert!(test_rule_expression(
        expression,
        &file(
            "ЗВІТ.final.gz",
            r"C:\\Архів\\ЗВІТ.final.gz",
            Some(".TAR.GZ")
        )
    )
    .unwrap());
}

#[test]
fn extension_falls_back_to_the_filename_last_suffix() {
    let expression =
        condition(RuleField::Extension, RuleMatcher::Equals, &["PDF"]);

    assert!(test_rule_expression(
        expression,
        &file("document.pdf", "/archive/document.pdf", None)
    )
    .unwrap());
}

#[test]
fn path_normalization_and_token_boundaries_are_separator_aware() {
    let token = condition(
        RuleField::DirectoryPath,
        RuleMatcher::ContainsToken,
        &["Особовий Склад"],
    );
    assert!(test_rule_expression(
        token.clone(),
        &file(
            "report.txt",
            r"C:\\Штаб\\Особовий Склад\\report.txt",
            Some("txt")
        )
    )
    .unwrap());
    assert!(!test_rule_expression(
        token,
        &file(
            "report.txt",
            r"C:\\Штаб\\НеОсобовий СкладX\\report.txt",
            Some("txt")
        )
    )
    .unwrap());
}

#[test]
fn full_path_token_recognizes_filename_before_extension() {
    let token =
        condition(RuleField::FullPath, RuleMatcher::ContainsToken, &["оружие"]);

    assert!(test_rule_expression(
        token.clone(),
        &file(
            "7 МСР оружие.docx",
            r"C:\Users\user\Desktop\Программы\БпС 2МСБ\копеейск\7 МСР оружие.docx",
            Some("docx"),
        ),
    )
    .unwrap());
    assert!(!test_rule_expression(
        token,
        &file(
            "сверхоружие.docx",
            r"C:\Users\user\Desktop\Программы\сверхоружие.docx",
            Some("docx"),
        ),
    )
    .unwrap());
}

#[test]
fn regex_is_unicode_and_case_insensitive_and_rejects_case_overrides() {
    let expression = condition(
        RuleField::FullPath,
        RuleMatcher::Regex,
        &[r"/НАВЧАННЯ/.*\.PDF$"],
    );
    assert!(test_rule_expression(
        expression,
        &file("План.pdf", "/Штаб/навчання/План.pdf", Some("pdf"))
    )
    .unwrap());

    let error = compile_tag_rules(vec![TagRuleDefinition {
        tag_id: Uuid::nil(),
        rule_expression: condition(
            RuleField::FileName,
            RuleMatcher::Regex,
            &["(?-i:secret)"],
        ),
    }])
    .err()
    .expect("inline case override must be rejected");
    assert_eq!(error.code, "inline_case_mode");
    assert_eq!(error.path, "rule_expression.values[0]");
}

#[test]
fn grouped_matchers_preserve_unicode_and_boundary_semantics() {
    assert!(test_rule_expression(
        condition(
            RuleField::FileName,
            RuleMatcher::Contains,
            &["відсутнє", "ЇЖАК"],
        ),
        &file("і\u{308}жак.txt", "/archive/і\u{308}жак.txt", Some("txt"),),
    )
    .unwrap());

    assert!(test_rule_expression(
        condition(
            RuleField::DirectoryPath,
            RuleMatcher::ContainsToken,
            &["неіснуюче", "Особовий Склад"],
        ),
        &file(
            "report.txt",
            r"C:\\Штаб\\Особовий Склад\\report.txt",
            Some("txt"),
        ),
    )
    .unwrap());

    assert!(test_rule_expression(
        condition(
            RuleField::FullPath,
            RuleMatcher::Regex,
            &[r"^ніколи$", r"/НАВЧАННЯ/.*\.PDF$"],
        ),
        &file("План.pdf", "/Штаб/навчання/План.pdf", Some("pdf")),
    )
    .unwrap());

    assert!(test_rule_expression(
        condition(RuleField::Extension, RuleMatcher::Equals, &["pdf", "s"],),
        &file("archive.ſ", "/archive/archive.ſ", Some("ſ")),
    )
    .unwrap());
}

#[test]
fn grouped_regex_reports_the_invalid_value_index() {
    let error = compile_tag_rules(vec![TagRuleDefinition {
        tag_id: Uuid::nil(),
        rule_expression: condition(
            RuleField::FileName,
            RuleMatcher::Regex,
            &["valid", "["],
        ),
    }])
    .err()
    .expect("invalid grouped regex must be rejected");

    assert_eq!(error.code, "invalid_regex");
    assert_eq!(error.path, "rule_expression.values[1]");
}

#[test]
fn nested_boolean_expressions_have_expected_precedence() {
    let expression = RuleExpression::RuleAll {
        children: vec![
            RuleExpression::RuleAny {
                children: vec![
                    condition(
                        RuleField::FileName,
                        RuleMatcher::Contains,
                        &["план"],
                    ),
                    condition(
                        RuleField::DirectoryPath,
                        RuleMatcher::Contains,
                        &["накази"],
                    ),
                ],
            },
            RuleExpression::Not {
                child: Box::new(condition(
                    RuleField::FullPath,
                    RuleMatcher::Contains,
                    &["чернетка"],
                )),
            },
        ],
    };

    assert!(test_rule_expression(
        expression.clone(),
        &file("План.docx", "/docs/План.docx", Some("docx"))
    )
    .unwrap());
    assert!(!test_rule_expression(
        expression,
        &file("План.docx", "/docs/чернетка/План.docx", Some("docx"))
    )
    .unwrap());
}

#[test]
fn compilation_rejects_invalid_values_and_excessively_complex_rules() {
    let cases = [
        (RuleExpression::RuleAny { children: vec![] }, "empty_group"),
        (
            condition(RuleField::FileName, RuleMatcher::Equals, &[]),
            "empty_values",
        ),
        (
            condition(
                RuleField::FileName,
                RuleMatcher::Equals,
                &["Value", "value"],
            ),
            "duplicate_value",
        ),
        (
            condition(RuleField::FileName, RuleMatcher::Regex, &["["]),
            "invalid_regex",
        ),
    ];

    for (rule_expression, expected_code) in cases {
        let error = compile_tag_rules(vec![TagRuleDefinition {
            tag_id: Uuid::nil(),
            rule_expression,
        }])
        .err()
        .expect("invalid expression must be rejected");
        assert_eq!(error.code, expected_code);
    }

    let mut too_deep =
        condition(RuleField::FileName, RuleMatcher::Equals, &["x"]);
    for _ in 0..16 {
        too_deep = RuleExpression::Not {
            child: Box::new(too_deep),
        };
    }
    let error = compile_tag_rules(vec![TagRuleDefinition {
        tag_id: Uuid::nil(),
        rule_expression: too_deep,
    }])
    .err()
    .expect("deep expression must be rejected");
    assert_eq!(error.code, "max_depth_exceeded");

    let too_many = RuleExpression::RuleAll {
        children: (0..256)
            .map(|_| {
                condition(RuleField::FileName, RuleMatcher::Contains, &["x"])
            })
            .collect(),
    };
    let error = compile_tag_rules(vec![TagRuleDefinition {
        tag_id: Uuid::nil(),
        rule_expression: too_many,
    }])
    .err()
    .expect("large expression must be rejected");
    assert_eq!(error.code, "max_nodes_exceeded");
}

#[test]
fn rule_json_is_strictly_tagged_and_rejects_unknown_fields() {
    let valid = json!({
        "op": "all",
        "children": [{
            "op": "match",
            "field": "file_name",
            "matcher": "contains",
            "values": ["report"]
        }]
    });
    let expression = deserialize_rule_expression(valid.clone()).unwrap();
    assert!(matches!(expression, RuleExpression::RuleAll { .. }));
    assert_eq!(serde_json::to_value(expression).unwrap(), valid);

    let error = deserialize_rule_expression(json!({
        "op": "match",
        "fields": ["file_name"],
        "matcher": "contains",
        "values": ["report"]
    }))
    .unwrap_err();
    assert_eq!(error.path, "rule_expression");
    assert_eq!(error.code, "invalid_expression");
}

#[test]
fn matched_tag_ids_are_sorted_and_each_tag_is_returned_once() {
    let smaller =
        Uuid::parse_str("018f0000-0000-7000-8000-000000000001").unwrap();
    let larger =
        Uuid::parse_str("018f0000-0000-7000-8000-000000000002").unwrap();
    let always = condition(RuleField::FullPath, RuleMatcher::Contains, &["/"]);
    let compiled = compile_tag_rules(vec![
        TagRuleDefinition {
            tag_id: larger,
            rule_expression: always.clone(),
        },
        TagRuleDefinition {
            tag_id: smaller,
            rule_expression: always,
        },
    ])
    .unwrap();

    assert_eq!(
        analyze(
            &compiled,
            &file("report.txt", "/archive/report.txt", Some("txt"))
        )
        .matched_tags,
        vec![smaller, larger]
    );
}

async fn insert_analytics_test_device(env: &Env) -> Uuid {
    let organism = mk_organism(
        &env.dbx,
        organism::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let owner = mk_login(
        &env.dbx,
        login::ActiveModel {
            login: Set(format!("analytics-worker-{}", Uuid::now_v7())),
            organism_id: Set(Some(organism.id)),
            roles: Set(json!([ROLE_DEVICE_SOURCE])),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let now = Utc::now().naive_utc();
    let device_id = Uuid::now_v7();
    device::ActiveModel {
        id: Set(device_id),
        name: Set(Some("Analytics worker fixture".to_string())),
        created_by: Set(owner.login),
        unit_id: Set(None),
        tags: Set(json!([])),
        external_url: Set(None),
        archived: Set(false),
        archived_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        custom_fields: Set(json!({})),
        organism_id: Set(organism.id),
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    device_id
}

fn hierarchy_label(id: Uuid) -> String {
    format!("n{}", id.to_string().replace('-', ""))
}

async fn insert_pending_files(
    env: &Env,
    device_id: Uuid,
    files: &[(&str, &str, &str)],
) -> Vec<Uuid> {
    let file_db = env.file_registry_db().unwrap().connection();
    let now = Utc::now().naive_utc();
    let root = file_entry::Entity::find()
        .filter(file_entry::Column::DeviceId.eq(device_id))
        .filter(file_entry::Column::ParentId.is_null())
        .filter(file_entry::Column::Kind.eq(FileEntryKind::Directory))
        .filter(file_entry::Column::Name.eq("C:\\"))
        .one(file_db)
        .await
        .unwrap();
    let (root_id, root_path) = if let Some(root) = root {
        (root.id, root.hierarchy_path)
    } else {
        let root_id = Uuid::now_v7();
        let root_path = hierarchy_label(root_id);
        file_entry::ActiveModel {
            id: Set(root_id),
            device_id: Set(device_id),
            parent_id: Set(None),
            kind: Set(FileEntryKind::Directory),
            name: Set("C:\\".to_string()),
            absolute_path: Set(None),
            hierarchy_path: Set(root_path.clone()),
            mime_type: Set(None),
            extension: Set(None),
            file_metadata_created_at: Set(None),
            file_metadata_modified_at: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
            content_path: Set(None),
            revision: Set(None),
            sync_id: Set(None),
            analysis_input_revision: Set(None),
            current_analysis_run_id: Set(None),
            source_file_state: Set(None),
            source_file_state_settled_at: Set(None),
            source_file_state_settled_by: Set(None),
        }
        .insert(file_db)
        .await
        .unwrap();
        (root_id, root_path)
    };
    let mut ids = Vec::with_capacity(files.len());
    for (name, absolute_path, extension) in files {
        let file_id = Uuid::now_v7();
        crate::file_registry::test_support::insert_entry(
            file_db,
            file_entry::ActiveModel {
                id: Set(file_id),
                device_id: Set(device_id),
                parent_id: Set(Some(root_id)),
                kind: Set(FileEntryKind::File),
                name: Set((*name).to_string()),
                absolute_path: Set(Some((*absolute_path).to_string())),
                hierarchy_path: Set(format!(
                    "{root_path}.{}",
                    hierarchy_label(file_id)
                )),
                mime_type: Set(None),
                extension: Set(Some((*extension).to_string())),
                file_metadata_created_at: Set(None),
                file_metadata_modified_at: Set(None),
                created_at: Set(now),
                updated_at: Set(now),
                content_path: Set(None),
                revision: Set(None),
                sync_id: Set(None),
                analysis_input_revision: Set(None),
                current_analysis_run_id: Set(None),
                source_file_state: Set(None),
                source_file_state_settled_at: Set(None),
                source_file_state_settled_by: Set(None),
            },
        )
        .await;
        ids.push(file_id);
    }
    ids
}

async fn sync_file_extension(
    env: &Env,
    device_id: Uuid,
    absolute_path: &str,
    extension: &str,
) -> Option<Uuid> {
    let device = device::Entity::find_by_id(device_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let owner = login::Entity::find()
        .filter(login::Column::Login.eq(device.created_by))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let actor = access::login_with_roles(&owner, &[ROLE_DEVICE_SOURCE]);
    let response = crate::devices::files::sync::automatic(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &actor,
        device_id,
        vec![RawSyncDeviceFileItem {
            absolute_path: absolute_path.to_string(),
            mime_type: None,
            extension: Some(extension.to_string()),
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            source_file_state: None,
        }],
    )
    .await
    .unwrap();
    assert_eq!(response.sync.counts.accepted, 1);
    response
        .sync
        .analysis_run_id
        .map(|run_id| Uuid::parse_str(&run_id).unwrap())
}

async fn save_extension_rule(env: &Env, tag_id: Uuid, extension: &str) {
    bl::save_rule(
        env.file_registry_db().unwrap().connection(),
        tag_id,
        Some(
            serde_json::to_value(condition(
                RuleField::Extension,
                RuleMatcher::Equals,
                &[extension],
            ))
            .unwrap(),
        ),
    )
    .await
    .unwrap();
}

async fn file_links(env: &Env, file_id: Uuid) -> Vec<device_file_tag::Model> {
    device_file_tag::Entity::find()
        .filter(device_file_tag::Column::FileEntryId.eq(file_id))
        .all(env.file_registry_db().unwrap().connection())
        .await
        .unwrap()
}

async fn current_definition(env: &Env) -> file_analysis_definition::Model {
    file_analysis_definition::Entity::find()
        .order_by_desc(file_analysis_definition::Column::DefinitionSequence)
        .one(env.file_registry_db().unwrap().connection())
        .await
        .unwrap()
        .unwrap()
}

async fn prepare_run(
    env: &Env,
    run_id: Uuid,
    page_size: u64,
) -> file_analysis_run::Model {
    let file_db = env.file_registry_db().unwrap().connection();
    for _ in 0..100 {
        let run = file_analysis_run::Entity::find_by_id(run_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap();
        if run.prepared_at.is_some() {
            return run;
        }
        assert!(
            queue::prepare_next_page(file_db, page_size)
                .await
                .unwrap()
                .did_work
        );
    }
    panic!("analysis run {run_id} did not finish preparation");
}

async fn run_to_completion(env: &Env, run_id: Uuid, batch_size: u64) {
    let file_db = env.file_registry_db().unwrap().connection();
    let cache = worker::RuleCache::default();
    for _ in 0..100 {
        let run = file_analysis_run::Entity::find_by_id(run_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap();
        if run.completed_at.is_some() {
            return;
        }
        assert!(worker::run_tick(env, &cache, batch_size, batch_size, 60)
            .await
            .unwrap());
    }
    panic!("analysis run {run_id} did not complete");
}

#[tokio::test]
#[serial_test::serial]
async fn semantic_rule_changes_publish_immutable_future_definitions() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let initial_definition = current_definition(env.as_ref()).await;
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await;

    let tag = bl::create_tag(file_db, "Definition tag".to_string())
        .await
        .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    bl::update_tag(file_db, tag_id, "Renamed definition tag".to_string())
        .await
        .unwrap();
    assert_eq!(
        file_analysis_definition::Entity::find()
            .count(file_db)
            .await
            .unwrap(),
        1,
        "tag creation and name-only changes are not evaluator semantics",
    );

    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    let captured_definition = current_definition(env.as_ref()).await;
    assert!(
        captured_definition.definition_sequence
            > initial_definition.definition_sequence
    );
    assert_eq!(
        file_analysis_run::Entity::find()
            .count(file_db)
            .await
            .unwrap(),
        0,
        "rule mutations must not implicitly create analysis runs",
    );

    let run = queue::create_manual_run(file_db, device_id).await.unwrap();
    assert_eq!(run.definition_id, captured_definition.id);
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    assert_eq!(
        current_definition(env.as_ref()).await.id,
        captured_definition.id,
        "an identical canonical rule set must reuse the definition",
    );
    save_extension_rule(env.as_ref(), tag_id, "txt").await;
    let future_definition = current_definition(env.as_ref()).await;
    assert_ne!(future_definition.id, captured_definition.id);
    assert_eq!(
        file_analysis_run::Entity::find_by_id(run.id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .definition_id,
        captured_definition.id,
        "an existing run keeps its captured definition",
    );

    let mut forbidden = captured_definition.into_active_model();
    forbidden.analyzer_version = Set(2);
    assert!(forbidden.update(file_db).await.is_err());
}

#[tokio::test]
#[serial_test::serial]
async fn zero_item_run_reports_only_its_completion_transition() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let run = queue::create_manual_run(file_db, device_id).await.unwrap();

    let completion = queue::prepare_next_page(file_db, 1).await.unwrap();
    assert!(completion.did_work);
    assert_eq!(completion.inserted_count, 0);
    assert_eq!(completion.completed_run_id, Some(run.id));

    let idle = queue::prepare_next_page(file_db, 1).await.unwrap();
    assert!(!idle.did_work);
    assert_eq!(idle.completed_run_id, None);
}

#[tokio::test]
#[serial_test::serial]
async fn manual_run_is_bounded_and_publishes_write_once_history() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_ids = insert_pending_files(
        env.as_ref(),
        device_id,
        &[
            ("first.pdf", r"C:\first.pdf", "pdf"),
            ("notes.txt", r"C:\notes.txt", "txt"),
            ("second.pdf", r"C:\second.pdf", "pdf"),
        ],
    )
    .await;
    let tag = bl::create_tag(file_db, "Bounded PDF".to_string())
        .await
        .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;

    let run = queue::create_manual_run(file_db, device_id).await.unwrap();
    assert_eq!(run.target_source_sequence, Some(3));
    let later_file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("later.pdf", r"C:\later.pdf", "pdf")],
    )
    .await[0];

    let prepared = prepare_run(env.as_ref(), run.id, 2).await;
    assert_eq!(prepared.item_count, 3);
    assert_eq!(prepared.completed_count, 0);
    assert!(prepared.completed_at.is_none());
    let prepared_file_ids = file_analysis_run_item::Entity::find()
        .filter(file_analysis_run_item::Column::Id.eq(run.id))
        .all(file_db)
        .await
        .unwrap()
        .into_iter()
        .map(|item| item.file_id)
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
        prepared_file_ids,
        file_ids.iter().copied().collect(),
        "a manual run must exclude revisions beyond its source watermark",
    );
    assert!(!prepared_file_ids.contains(&later_file_id));

    run_to_completion(env.as_ref(), run.id, 2).await;
    let completed_run = file_analysis_run::Entity::find_by_id(run.id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(completed_run.completed_count, 3);
    assert!(completed_run.completed_at.is_some());
    for file_id in &file_ids {
        let file = file_entry::Entity::find_by_id(*file_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(file.current_analysis_run_id, Some(run.id));
    }
    assert_eq!(
        file_entry::Entity::find_by_id(later_file_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .current_analysis_run_id,
        None,
    );
    assert_eq!(
        file_links(env.as_ref(), file_ids[0]).await[0].tag_id,
        tag_id
    );
    assert!(file_links(env.as_ref(), file_ids[1]).await.is_empty());
    assert_eq!(
        file_links(env.as_ref(), file_ids[2]).await[0].tag_id,
        tag_id
    );

    let summary = query::device_summary(file_db, device_id).await.unwrap();
    assert_eq!(
        (summary.total_file_count, summary.analyzed_file_count),
        (4, 3),
    );
    assert_eq!(summary.items.len(), 1);
    assert_eq!(summary.items[0].tag_name, "Bounded PDF");
    assert_eq!(summary.items[0].file_count, 2);
    let historical_item =
        file_analysis_run_item::Entity::find_by_id((run.id, file_ids[0]))
            .one(file_db)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(
        historical_item.result_tag_ids.as_deref(),
        Some(&[tag_id][..])
    );

    let device = device::Entity::find_by_id(device_id)
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let owner = login::Entity::find()
        .filter(login::Column::Login.eq(device.created_by))
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let run_response = bl::get_analysis_run(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &owner,
        run.id,
    )
    .await
    .unwrap();
    assert_eq!(run_response.run.run_id, run.id.to_string());
    assert_eq!(run_response.run.status, "completed");
    assert_eq!(
        (
            run_response.run.item_count,
            run_response.run.completed_count,
        ),
        (3, 3),
    );

    let first_file_page = bl::list_analysis_run_files(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &owner,
        run.id,
        Some(2),
        None,
    )
    .await
    .unwrap();
    assert_eq!(first_file_page.files.len(), 2);
    let second_file_page = bl::list_analysis_run_files(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &owner,
        run.id,
        Some(2),
        first_file_page.next_cursor,
    )
    .await
    .unwrap();
    assert_eq!(second_file_page.files.len(), 1);
    assert!(second_file_page.next_cursor.is_none());
    let historical_files = first_file_page
        .files
        .into_iter()
        .chain(second_file_page.files)
        .map(|file| (Uuid::parse_str(&file.file_id).unwrap(), file))
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(
        historical_files.keys().copied().collect::<Vec<_>>(),
        file_ids.to_vec(),
    );
    assert_eq!(
        historical_files[&file_ids[0]].tag_ids.as_deref(),
        Some(&[tag_id.to_string()][..]),
    );
    assert_eq!(
        historical_files[&file_ids[1]].tag_ids.as_deref(),
        Some(&[][..]),
    );

    let newer_run = queue::create_manual_run(file_db, device_id).await.unwrap();
    let first_run_page = bl::list_analysis_runs(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &owner,
        device_id,
        Some(1),
        None,
    )
    .await
    .unwrap();
    assert_eq!(first_run_page.runs[0].run_id, newer_run.id.to_string());
    assert_eq!(first_run_page.runs[0].status, "preparing");
    let second_run_page = bl::list_analysis_runs(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &owner,
        device_id,
        Some(1),
        first_run_page.next_cursor,
    )
    .await
    .unwrap();
    assert_eq!(second_run_page.runs[0].run_id, run.id.to_string());
    assert_eq!(second_run_page.runs[0].status, "completed");
    assert!(second_run_page.next_cursor.is_none());
    let mut forbidden = historical_item.into_active_model();
    forbidden.result_tag_ids = Set(Some(Vec::new()));
    assert!(forbidden.update(file_db).await.is_err());
    assert!(file_analysis_run_item::Entity::delete_by_id((
        run.id,
        file_ids[0]
    ))
    .exec(file_db)
    .await
    .is_err());
}

#[tokio::test]
#[serial_test::serial]
async fn an_open_sync_session_does_not_block_an_existing_run() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let run = queue::create_manual_run(file_db, device_id).await.unwrap();
    prepare_run(env.as_ref(), run.id, 1).await;

    let now = Utc::now().fixed_offset();
    file_sync_session::ActiveModel {
        id: Set(Uuid::now_v7()),
        device_id: Set(device_id),
        mode: Set(FileSyncSessionMode::Explicit),
        status: Set(FileSyncSessionStatus::Open),
        next_batch_index: Set(0),
        received_count: Set(0),
        accepted_count: Set(0),
        created_count: Set(0),
        updated_count: Set(0),
        rejected_count: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        completed_at: Set(None),
        expires_at: Set(Some(now + ChronoDuration::hours(1))),
    }
    .insert(file_db)
    .await
    .unwrap();

    run_to_completion(env.as_ref(), run.id, 1).await;
    assert_eq!(
        file_entry::Entity::find_by_id(file_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .current_analysis_run_id,
        Some(run.id),
    );
}
#[tokio::test]
#[serial_test::serial]
async fn rule_test_files_are_persisted_in_order_and_replaced() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let tag = bl::create_tag(
        env.file_registry_db().unwrap().connection(),
        format!("Rule fixtures {}", Uuid::now_v7()),
    )
    .await
    .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    let first_files = vec![
        RuleTestFile {
            absolute_path: r"C:\reports\report.pdf".to_string(),
            expected_match: true,
        },
        RuleTestFile {
            absolute_path: r"C:\reports\notes.txt".to_string(),
            expected_match: false,
        },
    ];

    let response = bl::test_rule(
        env.file_registry_db().unwrap().connection(),
        tag_id,
        Some(
            serde_json::to_value(condition(
                RuleField::Extension,
                RuleMatcher::Equals,
                &["pdf"],
            ))
            .unwrap(),
        ),
        first_files.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        response
            .results
            .iter()
            .map(|result| (result.matched, result.passed))
            .collect::<Vec<_>>(),
        vec![(true, true), (false, true)]
    );
    let stored = query::list_tag_test_files(
        env.file_registry_db().unwrap().connection(),
        tag_id,
    )
    .await
    .unwrap();
    assert_eq!(stored[0].name, "report.pdf");
    assert_eq!(stored[0].extension.as_deref(), Some("pdf"));
    assert!(stored[0].expected_match);
    assert_eq!(stored[1].name, "notes.txt");
    assert_eq!(stored[1].extension.as_deref(), Some("txt"));
    assert!(!stored[1].expected_match);
    assert_eq!(
        bl::list_tag_test_files(
            env.file_registry_db().unwrap().connection(),
            tag_id,
        )
        .await
        .unwrap(),
        first_files
    );

    let replacement = vec![RuleTestFile {
        absolute_path: r"C:\archive\replacement.docx".to_string(),
        expected_match: false,
    }];
    bl::test_rule(
        env.file_registry_db().unwrap().connection(),
        tag_id,
        None,
        replacement.clone(),
    )
    .await
    .unwrap();
    assert_eq!(
        bl::list_tag_test_files(
            env.file_registry_db().unwrap().connection(),
            tag_id,
        )
        .await
        .unwrap(),
        replacement
    );
}

#[tokio::test]
#[serial_test::serial]
async fn preparation_and_item_claims_are_bounded_and_skip_locked() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_ids = insert_pending_files(
        env.as_ref(),
        device_id,
        &[
            ("first.pdf", r"C:\first.pdf", "pdf"),
            ("second.pdf", r"C:\second.pdf", "pdf"),
        ],
    )
    .await;
    let run = queue::create_manual_run(file_db, device_id).await.unwrap();

    let (first_preparer, second_preparer) = tokio::join!(
        queue::prepare_next_page(file_db, 1),
        queue::prepare_next_page(file_db, 1),
    );
    assert!(
        first_preparer.unwrap().did_work || second_preparer.unwrap().did_work,
        "one concurrent preparer must claim the run",
    );
    let prepared = prepare_run(env.as_ref(), run.id, 1).await;
    assert_eq!(prepared.item_count, 2);
    assert_eq!(
        file_analysis_run_item::Entity::find()
            .filter(file_analysis_run_item::Column::Id.eq(run.id))
            .count(file_db)
            .await
            .unwrap(),
        2,
    );

    let first_claim =
        queue::claim_analysis_batch(file_db, 1, 60).await.unwrap();
    let second_claim =
        queue::claim_analysis_batch(file_db, 1, 60).await.unwrap();
    assert_eq!(first_claim.len(), 1);
    assert_eq!(second_claim.len(), 1);
    assert_ne!(first_claim[0].file_id, second_claim[0].file_id);
    assert_ne!(first_claim[0].lease_token, second_claim[0].lease_token);
    assert_eq!(
        [first_claim[0].file_id, second_claim[0].file_id]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>(),
        file_ids.into_iter().collect(),
    );

    for (index, claim) in [&first_claim, &second_claim].into_iter().enumerate()
    {
        let completion = queue::complete_analysis_batch(
            file_db,
            claim[0].lease_token,
            &[queue::CompletedAnalysisFile {
                run_id: claim[0].run_id,
                file_id: claim[0].file_id,
                metadata_revision: claim[0].metadata_revision,
                matched_tag_ids: Vec::new(),
            }],
        )
        .await
        .unwrap();
        assert_eq!(completion.completed_count, 1);
        assert_eq!(completion.completed_run_id, (index == 1).then_some(run.id),);
    }
    let completed = file_analysis_run::Entity::find_by_id(run.id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(completed.completed_count, 2);
    assert!(completed.completed_at.is_some());
}

#[tokio::test]
#[serial_test::serial]
async fn newer_run_wins_publication_while_older_history_still_commits() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let tag = bl::create_tag(file_db, "Publication precedence".to_string())
        .await
        .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    let older_run = queue::create_manual_run(file_db, device_id).await.unwrap();
    prepare_run(env.as_ref(), older_run.id, 1).await;

    save_extension_rule(env.as_ref(), tag_id, "txt").await;
    let newer_run = queue::create_manual_run(file_db, device_id).await.unwrap();
    prepare_run(env.as_ref(), newer_run.id, 1).await;
    assert!(newer_run.run_sequence > older_run.run_sequence);

    let older_claim =
        queue::claim_analysis_batch(file_db, 1, 60).await.unwrap();
    let newer_claim =
        queue::claim_analysis_batch(file_db, 1, 60).await.unwrap();
    assert_eq!(older_claim[0].run_id, older_run.id);
    assert_eq!(newer_claim[0].run_id, newer_run.id);

    queue::complete_analysis_batch(
        file_db,
        newer_claim[0].lease_token,
        &[queue::CompletedAnalysisFile {
            run_id: newer_run.id,
            file_id,
            metadata_revision: newer_claim[0].metadata_revision,
            matched_tag_ids: Vec::new(),
        }],
    )
    .await
    .unwrap();
    assert_eq!(
        file_entry::Entity::find_by_id(file_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .current_analysis_run_id,
        Some(newer_run.id),
    );

    queue::complete_analysis_batch(
        file_db,
        older_claim[0].lease_token,
        &[queue::CompletedAnalysisFile {
            run_id: older_run.id,
            file_id,
            metadata_revision: older_claim[0].metadata_revision,
            matched_tag_ids: vec![tag_id],
        }],
    )
    .await
    .unwrap();
    assert_eq!(
        file_entry::Entity::find_by_id(file_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .current_analysis_run_id,
        Some(newer_run.id),
        "an older run may complete historically but cannot republish current state",
    );
    assert!(file_links(env.as_ref(), file_id).await.is_empty());
    assert_eq!(
        file_analysis_run_item::Entity::find_by_id((older_run.id, file_id))
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .result_tag_ids
            .as_deref(),
        Some(&[tag_id][..]),
    );
    let summary = query::device_summary(file_db, device_id).await.unwrap();
    assert_eq!(
        (summary.total_file_count, summary.analyzed_file_count),
        (1, 1),
    );
    assert!(
        summary.items.is_empty(),
        "the overall summary must reflect current links, not an older run"
    );
}

#[tokio::test]
#[serial_test::serial]
async fn evaluator_input_change_blocks_stale_publication_but_keeps_history() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let tag = bl::create_tag(file_db, "Stale PDF".to_string())
        .await
        .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    let stale_run = queue::create_manual_run(file_db, device_id).await.unwrap();
    prepare_run(env.as_ref(), stale_run.id, 1).await;
    let stale_claim =
        queue::claim_analysis_batch(file_db, 1, 60).await.unwrap();

    let current_run_id =
        sync_file_extension(env.as_ref(), device_id, r"C:\report.pdf", "txt")
            .await
            .expect("evaluator input change creates an automatic run");
    queue::complete_analysis_batch(
        file_db,
        stale_claim[0].lease_token,
        &[queue::CompletedAnalysisFile {
            run_id: stale_run.id,
            file_id,
            metadata_revision: stale_claim[0].metadata_revision,
            matched_tag_ids: vec![tag_id],
        }],
    )
    .await
    .unwrap();
    assert_eq!(
        file_entry::Entity::find_by_id(file_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .current_analysis_run_id,
        None,
        "a result for an obsolete evaluator input must not become current",
    );
    assert!(file_links(env.as_ref(), file_id).await.is_empty());
    assert_eq!(
        file_analysis_run_item::Entity::find_by_id((stale_run.id, file_id))
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .result_tag_ids
            .as_deref(),
        Some(&[tag_id][..]),
    );

    run_to_completion(env.as_ref(), current_run_id, 1).await;
    assert_eq!(
        file_entry::Entity::find_by_id(file_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .current_analysis_run_id,
        Some(current_run_id),
    );
    assert!(file_links(env.as_ref(), file_id).await.is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn archived_tag_stays_in_history_but_not_current_projection() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let tag = bl::create_tag(file_db, "Archive during analysis".to_string())
        .await
        .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    let run = queue::create_manual_run(file_db, device_id).await.unwrap();
    prepare_run(env.as_ref(), run.id, 1).await;
    let claim = queue::claim_analysis_batch(file_db, 1, 60).await.unwrap();

    bl::archive_tag(file_db, tag_id).await.unwrap();
    queue::complete_analysis_batch(
        file_db,
        claim[0].lease_token,
        &[queue::CompletedAnalysisFile {
            run_id: run.id,
            file_id,
            metadata_revision: claim[0].metadata_revision,
            matched_tag_ids: vec![tag_id],
        }],
    )
    .await
    .unwrap();

    assert_eq!(
        file_entry::Entity::find_by_id(file_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .current_analysis_run_id,
        Some(run.id),
    );
    assert!(file_links(env.as_ref(), file_id).await.is_empty());
    assert_eq!(
        file_analysis_run_item::Entity::find_by_id((run.id, file_id))
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .result_tag_ids
            .as_deref(),
        Some(&[tag_id][..]),
    );
}

#[tokio::test]
#[serial_test::serial]
async fn an_expired_item_lease_is_reclaimed_without_double_completion() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("retry.txt", r"C:\retry.txt", "txt")],
    )
    .await[0];
    let run = queue::create_manual_run(file_db, device_id).await.unwrap();
    prepare_run(env.as_ref(), run.id, 1).await;

    let expired_claim =
        queue::claim_analysis_batch(file_db, 1, 0).await.unwrap();
    let retry_claim =
        queue::claim_analysis_batch(file_db, 1, 60).await.unwrap();
    assert_eq!(expired_claim[0].file_id, file_id);
    assert_eq!(retry_claim[0].file_id, file_id);
    assert_ne!(expired_claim[0].lease_token, retry_claim[0].lease_token);
    let stale_completion = queue::complete_analysis_batch(
        file_db,
        expired_claim[0].lease_token,
        &[queue::CompletedAnalysisFile {
            run_id: run.id,
            file_id,
            metadata_revision: expired_claim[0].metadata_revision,
            matched_tag_ids: Vec::new(),
        }],
    )
    .await;
    assert!(stale_completion.is_err());

    assert_eq!(
        queue::complete_analysis_batch(
            file_db,
            retry_claim[0].lease_token,
            &[queue::CompletedAnalysisFile {
                run_id: run.id,
                file_id,
                metadata_revision: retry_claim[0].metadata_revision,
                matched_tag_ids: Vec::new(),
            }],
        )
        .await
        .unwrap()
        .completed_count,
        1,
    );
    let completed = file_analysis_run::Entity::find_by_id(run.id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(completed.completed_count, 1);
    assert!(completed.completed_at.is_some());
}

#[tokio::test]
#[serial_test::serial]
async fn reanalyze_all_creates_one_bounded_run_per_nonempty_device() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let first_device_id = insert_analytics_test_device(env.as_ref()).await;
    let second_device_id = insert_analytics_test_device(env.as_ref()).await;
    let empty_device_id = insert_analytics_test_device(env.as_ref()).await;
    insert_pending_files(
        env.as_ref(),
        first_device_id,
        &[("first.txt", r"C:\first.txt", "txt")],
    )
    .await;
    insert_pending_files(
        env.as_ref(),
        second_device_id,
        &[
            ("second.txt", r"C:\second.txt", "txt"),
            ("third.txt", r"C:\third.txt", "txt"),
        ],
    )
    .await;

    let scheduled = queue::create_manual_runs_all(file_db).await.unwrap();
    assert_eq!(scheduled.created_run_count, 2);
    let runs = file_analysis_run::Entity::find()
        .order_by_asc(file_analysis_run::Column::DeviceId)
        .all(file_db)
        .await
        .unwrap();
    assert_eq!(runs.len(), 2);
    assert_eq!(
        runs.iter()
            .map(|run| run.device_id)
            .collect::<std::collections::BTreeSet<_>>(),
        [first_device_id, second_device_id].into_iter().collect(),
    );
    assert!(runs
        .iter()
        .all(|run| run.definition_id == scheduled.definition_id));
    assert!(runs.iter().any(|run| {
        run.device_id == first_device_id
            && run.target_source_sequence == Some(1)
    }));
    assert!(runs.iter().any(|run| {
        run.device_id == second_device_id
            && run.target_source_sequence == Some(2)
    }));
    assert!(!runs.iter().any(|run| run.device_id == empty_device_id));
}

#[tokio::test]
#[serial_test::serial]
async fn metadata_only_sync_preserves_current_analysis_projection() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let run = queue::create_manual_run(file_db, device_id).await.unwrap();
    run_to_completion(env.as_ref(), run.id, 1).await;
    let before = file_entry::Entity::find_by_id(file_id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();

    let source_login = login::Entity::find()
        .filter(
            login::Column::Login.eq(device::Entity::find_by_id(device_id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .created_by),
        )
        .one(&env.dbx)
        .await
        .unwrap()
        .unwrap();
    let actor = access::login_with_roles(&source_login, &[ROLE_DEVICE_SOURCE]);
    let response = crate::devices::files::sync::automatic(
        &env.dbx,
        env.file_registry_db().unwrap(),
        &actor,
        device_id,
        vec![RawSyncDeviceFileItem {
            absolute_path: r"C:\report.pdf".to_string(),
            mime_type: Some("application/pdf".to_string()),
            extension: Some("pdf".to_string()),
            file_metadata_created_at: None,
            file_metadata_modified_at: None,
            source_file_state: None,
        }],
    )
    .await
    .unwrap();
    assert_eq!(response.sync.counts.updated, 1);
    assert_eq!(response.sync.analysis_run_id, None);

    let after = file_entry::Entity::find_by_id(file_id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert!(after.revision > before.revision);
    assert_eq!(
        after.analysis_input_revision,
        before.analysis_input_revision,
    );
    assert_eq!(after.current_analysis_run_id, Some(run.id));
    let latest_revision =
        file_revision::Entity::find_by_id((file_id, after.revision.unwrap()))
            .one(file_db)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(
        latest_revision.analysis_input_revision,
        before.analysis_input_revision.unwrap(),
    );
    assert_eq!(
        file_analysis_run::Entity::find()
            .count(file_db)
            .await
            .unwrap(),
        1,
        "metadata-only sync must not schedule another analysis run",
    );
}

#[tokio::test]
#[serial_test::serial]
async fn current_analysis_pointer_rejects_an_incomplete_run_item() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let completed_run =
        queue::create_manual_run(file_db, device_id).await.unwrap();
    run_to_completion(env.as_ref(), completed_run.id, 1).await;
    let incomplete_run =
        queue::create_manual_run(file_db, device_id).await.unwrap();
    prepare_run(env.as_ref(), incomplete_run.id, 1).await;

    let mut invalid_pointer = file_entry::Entity::find_by_id(file_id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap()
        .into_active_model();
    invalid_pointer.current_analysis_run_id = Set(Some(incomplete_run.id));
    let error = invalid_pointer.update(file_db).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("current file analysis must be complete"),
        "unexpected pointer constraint error: {error}",
    );
    assert_eq!(
        file_entry::Entity::find_by_id(file_id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .current_analysis_run_id,
        Some(completed_run.id),
    );
}

#[tokio::test]
#[serial_test::serial]
async fn run_items_reject_invalid_results_and_late_targets() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("captured.pdf", r"C:\captured.pdf", "pdf")],
    )
    .await[0];
    let run = queue::create_manual_run(file_db, device_id).await.unwrap();
    prepare_run(env.as_ref(), run.id, 1).await;

    let mut invalid_result =
        file_analysis_run_item::Entity::find_by_id((run.id, file_id))
            .one(file_db)
            .await
            .unwrap()
            .unwrap()
            .into_active_model();
    invalid_result.result_tag_ids = Set(Some(vec![Uuid::now_v7()]));
    invalid_result.completed_at = Set(Some(Utc::now().fixed_offset()));
    let error = invalid_result.update(file_db).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("analysis result tag ID is not in the run definition"),
        "unexpected result constraint error: {error}",
    );

    let late_file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("late.pdf", r"C:\late.pdf", "pdf")],
    )
    .await[0];
    let late_revision = file_revision::Entity::find_by_id((late_file_id, 1))
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    let error = file_analysis_run_item::ActiveModel {
        id: Set(run.id),
        file_id: Set(late_file_id),
        metadata_revision: Set(late_revision.analysis_input_revision),
        lease_token: Set(None),
        lease_expires_at: Set(None),
        result_tag_ids: Set(None),
        completed_at: Set(None),
    }
    .insert(file_db)
    .await
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("prepared analysis runs have a fixed item set"),
        "unexpected fixed-set constraint error: {error}",
    );
}
