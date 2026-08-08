use super::rules::{
    analyze, compile_tag_rules, deserialize_rule_expression,
    test_rule_expression,
};
use super::types::{
    FileAnalysisInput, RuleExpression, RuleField, RuleMatcher, RuleTestFile,
    TagRuleDefinition,
};
use super::{bl, query, queue, worker};
use crate::entities::{device, login, organism};
use crate::file_registry::entities::{
    analytics_tag, device_file_tag, file_analysis_control,
    file_analysis_reanalysis_job, file_analysis_state, file_entry,
    sea_orm_active_enums::FileEntryKind,
};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::types::Env;
use chrono::{Duration as ChronoDuration, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait,
    IntoActiveModel, PaginatorTrait, QueryFilter,
};
use serde_json::json;
use std::sync::Arc;
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
        }
        .insert(file_db)
        .await
        .unwrap();
        (root_id, root_path)
    };
    let mut ids = Vec::with_capacity(files.len());
    for (name, absolute_path, extension) in files {
        let file_id = Uuid::now_v7();
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
        }
        .insert(file_db)
        .await
        .unwrap();
        ids.push(file_id);
    }
    ids
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

async fn analysis_state(
    env: &Env,
    file_id: Uuid,
) -> file_analysis_state::Model {
    file_analysis_state::Entity::find_by_id(file_id)
        .one(env.file_registry_db().unwrap().connection())
        .await
        .unwrap()
        .unwrap()
}

async fn schedule_device_reanalysis(env: &Env, device_id: Uuid) -> u64 {
    let rule_revision =
        query::rule_set_revision(env.file_registry_db().unwrap().connection())
            .await
            .unwrap();
    queue::schedule_reanalysis(
        env.file_registry_db().unwrap().connection(),
        Some(device_id),
        rule_revision,
    )
    .await
    .unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn missing_analysis_state_is_backfilled_as_pending() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let file_db = env.file_registry_db().unwrap().connection();
    file_analysis_state::Entity::delete_by_id(file_id)
        .exec(file_db)
        .await
        .unwrap();

    assert!(queue::backfill_missing_analysis_state(file_db, 1)
        .await
        .unwrap());
    let state = analysis_state(env.as_ref(), file_id).await;
    assert_eq!(state.source_revision, 1);
    assert_eq!(state.analyzed_source_revision, 0);
    assert_eq!(state.analyzed_rule_revision, 0);
    assert!(state.pending);
}

#[tokio::test]
#[serial_test::serial]
async fn shared_rule_cache_reuses_and_refreshes_compiled_rules() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let tag = bl::create_tag(
        env.file_registry_db().unwrap().connection(),
        "Кеш правил".to_string(),
    )
    .await
    .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    let cache = worker::RuleCache::default();

    let first_rules = cache
        .load_rules(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
    assert_eq!(
        analyze(
            &first_rules.rules,
            &file("report.pdf", r"C:\report.pdf", Some("pdf"))
        )
        .matched_tags,
        [tag_id]
    );

    let second_rules = cache
        .load_rules(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
    assert!(
        Arc::ptr_eq(&first_rules.rules, &second_rules.rules),
        "an unchanged DB revision must reuse the compiled rules"
    );

    save_extension_rule(env.as_ref(), tag_id, "txt").await;
    let third_rules = cache
        .load_rules(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
    assert!(
        !Arc::ptr_eq(&second_rules.rules, &third_rules.rules),
        "a committed rule mutation must invalidate every worker cache"
    );
    assert!(analyze(
        &third_rules.rules,
        &file("report.pdf", r"C:\report.pdf", Some("pdf"))
    )
    .matched_tags
    .is_empty());
    assert_eq!(
        analyze(
            &third_rules.rules,
            &file("notes.txt", r"C:\notes.txt", Some("txt"))
        )
        .matched_tags,
        [tag_id]
    );
}

#[tokio::test]
#[serial_test::serial]
async fn reanalysis_preserves_an_unchanged_tag_link() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let tag = bl::create_tag(
        env.file_registry_db().unwrap().connection(),
        "Незмінний PDF".to_string(),
    )
    .await
    .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    let cache = worker::RuleCache::default();

    assert!(worker::run_tick_with(env.as_ref(), &cache, 1)
        .await
        .unwrap());
    let before = file_links(env.as_ref(), file_id).await.remove(0);
    assert_eq!(schedule_device_reanalysis(env.as_ref(), device_id).await, 1,);

    assert!(worker::run_tick_with(env.as_ref(), &cache, 1)
        .await
        .unwrap());
    let after = file_links(env.as_ref(), file_id).await.remove(0);
    assert_eq!(
        after, before,
        "set-delta reconciliation must not rewrite an unchanged membership"
    );
}

#[tokio::test]
#[serial_test::serial]
async fn worker_requires_explicit_reanalysis_after_rule_changes_and_restore() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let tag = bl::create_tag(
        env.file_registry_db().unwrap().connection(),
        "Звіти".to_string(),
    )
    .await
    .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;

    assert!(worker::run_tick(env.as_ref()).await.unwrap());
    assert_eq!(file_links(env.as_ref(), file_id).await.len(), 1);

    save_extension_rule(env.as_ref(), tag_id, "txt").await;
    assert!(!worker::run_tick(env.as_ref()).await.unwrap());
    assert_eq!(
        file_links(env.as_ref(), file_id).await[0].tag_id,
        tag_id,
        "saving a rule must not silently rewrite analyzed files",
    );

    assert_eq!(schedule_device_reanalysis(env.as_ref(), device_id).await, 1,);
    assert!(worker::run_tick(env.as_ref()).await.unwrap());
    assert!(file_links(env.as_ref(), file_id).await.is_empty());

    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    assert_eq!(schedule_device_reanalysis(env.as_ref(), device_id).await, 1,);
    assert!(worker::run_tick(env.as_ref()).await.unwrap());
    assert_eq!(file_links(env.as_ref(), file_id).await.len(), 1);

    bl::archive_tag(env.file_registry_db().unwrap().connection(), tag_id)
        .await
        .unwrap();
    assert!(file_links(env.as_ref(), file_id).await.is_empty());
    bl::restore_tag(env.file_registry_db().unwrap().connection(), tag_id)
        .await
        .unwrap();
    assert!(!worker::run_tick(env.as_ref()).await.unwrap());
    assert!(file_links(env.as_ref(), file_id).await.is_empty());

    assert_eq!(schedule_device_reanalysis(env.as_ref(), device_id).await, 1,);
    assert!(worker::run_tick(env.as_ref()).await.unwrap());
    assert_eq!(file_links(env.as_ref(), file_id).await.len(), 1);
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
        },
        RuleTestFile {
            absolute_path: r"C:\reports\notes.txt".to_string(),
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
            .map(|result| result.matched)
            .collect::<Vec<_>>(),
        vec![true, false]
    );
    let stored = query::list_tag_test_files(
        env.file_registry_db().unwrap().connection(),
        tag_id,
    )
    .await
    .unwrap();
    assert_eq!(stored[0].name, "report.pdf");
    assert_eq!(stored[0].extension.as_deref(), Some("pdf"));
    assert_eq!(stored[1].name, "notes.txt");
    assert_eq!(stored[1].extension.as_deref(), Some("txt"));
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
async fn concurrent_workers_skip_locked_rows_without_duplicate_links() {
    let (env, _guard) = cleanup_locked().await.unwrap();
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
    let tag = bl::create_tag(
        env.file_registry_db().unwrap().connection(),
        "PDF".to_string(),
    )
    .await
    .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;

    let cache = worker::RuleCache::default();
    let (first, second) = tokio::join!(
        worker::run_tick_with(env.as_ref(), &cache, 1),
        worker::run_tick_with(env.as_ref(), &cache, 1),
    );
    let processed = [first.unwrap(), second.unwrap()];
    assert_eq!(processed, [true, true]);
    let _ = worker::run_tick_with(env.as_ref(), &cache, 1)
        .await
        .unwrap();
    assert!(!worker::run_tick_with(env.as_ref(), &cache, 1)
        .await
        .unwrap());

    let states = file_analysis_state::Entity::find()
        .filter(
            file_analysis_state::Column::FileEntryId
                .is_in(file_ids.iter().copied()),
        )
        .all(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
    assert_eq!(states.len(), 2);
    assert!(states.iter().all(|state| {
        !state.pending
            && state.source_revision == state.analyzed_source_revision
            && state.required_generation == state.analyzed_generation
            && state.lease_token.is_none()
    }));

    let links = device_file_tag::Entity::find()
        .filter(device_file_tag::Column::TagId.eq(tag_id))
        .all(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
    assert_eq!(links.len(), 2);
    assert_eq!(
        links
            .iter()
            .map(|link| link.file_entry_id)
            .collect::<std::collections::BTreeSet<_>>()
            .len(),
        2,
    );
}

#[tokio::test]
#[serial_test::serial]
async fn invalid_persisted_rule_rolls_back_and_leaves_files_pending() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("pending.pdf", r"C:\pending.pdf", "pdf")],
    )
    .await[0];
    let tag = query::create_tag(
        env.file_registry_db().unwrap().connection(),
        Uuid::now_v7(),
        "Invalid direct write".to_string(),
    )
    .await
    .unwrap();
    let mut tag: analytics_tag::ActiveModel = tag.into();
    tag.rule_expression = Set(Some(json!({"op": "unknown"})));
    let tag = tag
        .update(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();

    let error = worker::run_tick(env.as_ref()).await.unwrap_err();
    assert!(error.to_string().contains(&tag.id.to_string()));
    let state = analysis_state(env.as_ref(), file_id).await;
    assert!(state.pending);
    assert!(state.lease_token.is_none());
    assert!(file_links(env.as_ref(), file_id).await.is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn metadata_change_during_a_lease_discards_the_stale_result() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let tag = bl::create_tag(
        env.file_registry_db().unwrap().connection(),
        "Старий PDF".to_string(),
    )
    .await
    .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    let cache = worker::RuleCache::default();
    let rule_snapshot = cache
        .load_rules(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let batch = queue::claim_pending_analysis_files(file_db, 1)
        .await
        .unwrap();
    assert_eq!(batch.files.len(), 1);
    let lease_token = batch.lease_token;
    assert_eq!(
        analysis_state(env.as_ref(), file_id).await.lease_token,
        Some(lease_token)
    );

    let file = file_entry::Entity::find_by_id(file_id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    let mut file = file.into_active_model();
    file.name = Set("notes.txt".to_string());
    file.absolute_path = Set(Some(r"C:\notes.txt".to_string()));
    file.extension = Set(Some("txt".to_string()));
    file.updated_at = Set(Utc::now().naive_utc());
    file.update(file_db).await.unwrap();

    let invalidated = analysis_state(env.as_ref(), file_id).await;
    assert_eq!(invalidated.source_revision, 2);
    assert!(invalidated.pending);
    assert_eq!(invalidated.lease_token, Some(lease_token));

    worker::process_claimed_batch(env.as_ref(), &rule_snapshot, batch)
        .await
        .unwrap();
    let released = analysis_state(env.as_ref(), file_id).await;
    assert!(released.pending);
    assert_eq!(released.analyzed_source_revision, 0);
    assert!(released.lease_token.is_none());
    assert!(file_links(env.as_ref(), file_id).await.is_empty());

    assert!(worker::run_tick_with(env.as_ref(), &cache, 1)
        .await
        .unwrap());
    let completed = analysis_state(env.as_ref(), file_id).await;
    assert!(!completed.pending);
    assert_eq!(
        completed.analyzed_source_revision,
        completed.source_revision
    );
    assert!(file_links(env.as_ref(), file_id).await.is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn rule_change_during_a_lease_discards_the_stale_result() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("report.pdf", r"C:\report.pdf", "pdf")],
    )
    .await[0];
    let tag = bl::create_tag(
        env.file_registry_db().unwrap().connection(),
        "Поточний PDF".to_string(),
    )
    .await
    .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    let cache = worker::RuleCache::default();
    let stale_snapshot = cache
        .load_rules(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
    let file_db = env.file_registry_db().unwrap().connection();
    let batch = queue::claim_pending_analysis_files(file_db, 1)
        .await
        .unwrap();
    assert_eq!(batch.files.len(), 1);

    save_extension_rule(env.as_ref(), tag_id, "txt").await;
    assert!(
        query::rule_set_revision(env.file_registry_db().unwrap().connection(),)
            .await
            .unwrap()
            > stale_snapshot.revision
    );
    worker::process_claimed_batch(env.as_ref(), &stale_snapshot, batch)
        .await
        .unwrap();

    let released = analysis_state(env.as_ref(), file_id).await;
    assert!(released.pending);
    assert_eq!(released.analyzed_rule_revision, 0);
    assert!(released.lease_token.is_none());
    assert!(file_links(env.as_ref(), file_id).await.is_empty());

    assert!(worker::run_tick_with(env.as_ref(), &cache, 1)
        .await
        .unwrap());
    let completed = analysis_state(env.as_ref(), file_id).await;
    assert!(!completed.pending);
    assert_eq!(
        completed.analyzed_rule_revision,
        query::rule_set_revision(env.file_registry_db().unwrap().connection(),)
            .await
            .unwrap()
    );
    assert!(file_links(env.as_ref(), file_id).await.is_empty());
}

#[tokio::test]
#[serial_test::serial]
async fn reanalysis_job_expands_in_bounded_batches_and_excludes_new_files() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_ids = insert_pending_files(
        env.as_ref(),
        device_id,
        &[
            ("first.pdf", r"C:\first.pdf", "pdf"),
            ("second.pdf", r"C:\second.pdf", "pdf"),
            ("third.pdf", r"C:\third.pdf", "pdf"),
        ],
    )
    .await;
    let cache = worker::RuleCache::default();
    assert!(worker::run_tick_with(env.as_ref(), &cache, 10)
        .await
        .unwrap());
    for file_id in &file_ids {
        assert!(!analysis_state(env.as_ref(), *file_id).await.pending);
    }

    assert_eq!(schedule_device_reanalysis(env.as_ref(), device_id).await, 3);
    assert_eq!(
        schedule_device_reanalysis(env.as_ref(), device_id).await,
        0,
        "the same active scope and rule revision must deduplicate"
    );
    for file_id in &file_ids {
        let state = analysis_state(env.as_ref(), *file_id).await;
        assert!(!state.pending);
        assert_eq!(state.required_generation, 0);
    }

    let file_db = env.file_registry_db().unwrap().connection();
    let job = file_analysis_reanalysis_job::Entity::find()
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(job.scheduled_file_count, 3);
    assert_eq!(job.expanded_file_count, 0);
    assert!(job.expanded_at.is_none());
    let upper_file_entry_id = job.upper_file_entry_id;

    let new_file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("later.pdf", r"C:\later.pdf", "pdf")],
    )
    .await[0];
    assert!(new_file_id > upper_file_entry_id);

    assert!(queue::expand_next_reanalysis_job(file_db, 2).await.unwrap());
    let partially_expanded =
        file_analysis_reanalysis_job::Entity::find_by_id(job.id)
            .one(file_db)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(partially_expanded.expanded_file_count, 2);
    assert!(partially_expanded.expanded_at.is_none());
    assert_eq!(
        file_analysis_state::Entity::find()
            .filter(
                file_analysis_state::Column::FileEntryId
                    .is_in(file_ids.iter().copied())
            )
            .filter(
                file_analysis_state::Column::RequiredGeneration
                    .eq(job.generation)
            )
            .count(file_db)
            .await
            .unwrap(),
        2
    );

    assert!(queue::expand_next_reanalysis_job(file_db, 2).await.unwrap());
    let expanded = file_analysis_reanalysis_job::Entity::find_by_id(job.id)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(expanded.expanded_file_count, 3);
    assert!(expanded.expanded_at.is_some());
    for file_id in &file_ids {
        let state = analysis_state(env.as_ref(), *file_id).await;
        assert!(state.pending);
        assert_eq!(state.required_generation, job.generation);
    }
    let new_file_state = analysis_state(env.as_ref(), new_file_id).await;
    assert!(new_file_state.pending);
    assert_eq!(new_file_state.required_generation, 0);

    let control = file_analysis_control::Entity::find_by_id(true)
        .one(file_db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(control.next_generation, job.generation + 1);
}

#[tokio::test]
#[serial_test::serial]
async fn failed_and_expired_leases_remain_durably_retryable() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let device_id = insert_analytics_test_device(env.as_ref()).await;
    let file_id = insert_pending_files(
        env.as_ref(),
        device_id,
        &[("retry.pdf", r"C:\retry.pdf", "pdf")],
    )
    .await[0];
    let file_db = env.file_registry_db().unwrap().connection();

    let first_claim = queue::claim_pending_analysis_files(file_db, 1)
        .await
        .unwrap();
    assert_eq!(first_claim.files.len(), 1);
    assert_eq!(
        queue::release_claim_with_error(
            file_db,
            first_claim.lease_token,
            "deliberate failure",
        )
        .await
        .unwrap(),
        1
    );
    let failed = analysis_state(env.as_ref(), file_id).await;
    assert!(failed.pending);
    assert!(failed.lease_token.is_none());
    assert_eq!(failed.attempt_count, 1);
    assert_eq!(failed.last_error.as_deref(), Some("deliberate failure"));
    assert!(failed.available_at > Utc::now().fixed_offset());
    assert!(queue::claim_pending_analysis_files(file_db, 1)
        .await
        .unwrap()
        .files
        .is_empty());

    let mut failed = failed.into_active_model();
    failed.available_at =
        Set((Utc::now() - ChronoDuration::seconds(1)).fixed_offset());
    failed.update(file_db).await.unwrap();
    let second_claim = queue::claim_pending_analysis_files(file_db, 1)
        .await
        .unwrap();
    assert_eq!(second_claim.files.len(), 1);

    let leased = analysis_state(env.as_ref(), file_id).await;
    let mut leased = leased.into_active_model();
    leased.lease_expires_at = Set(Some(
        (Utc::now() - ChronoDuration::seconds(1)).fixed_offset(),
    ));
    leased.update(file_db).await.unwrap();
    assert_eq!(
        queue::recover_expired_analysis_leases(file_db, 10)
            .await
            .unwrap(),
        1
    );

    let recovered = analysis_state(env.as_ref(), file_id).await;
    assert!(recovered.pending);
    assert!(recovered.lease_token.is_none());
    assert_eq!(recovered.attempt_count, 2);
    assert_eq!(
        recovered.last_error.as_deref(),
        Some("analysis lease expired before acknowledgement")
    );
}
