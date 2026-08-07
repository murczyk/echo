use super::rules::{
    analyze, compile_tag_rules, deserialize_rule_expression,
    test_rule_expression,
};
use super::types::{
    FileAnalysisInput, RuleExpression, RuleField, RuleMatcher, RuleTestFile,
    TagRuleDefinition,
};
use super::{bl, query, worker};
use crate::entities::{
    analytics_tag, device, device_file_tag, login, organism,
};
use crate::file_registry::entities::{
    file_entry, sea_orm_active_enums::FileEntryKind,
};
use crate::functest::tests::{cleanup_locked, mk_login, mk_organism};
use crate::types::Env;
use chrono::Utc;
use sea_orm::{
    ActiveModelTrait,
    ActiveValue::{NotSet, Set},
    ColumnTrait, DbBackend, EntityTrait, QueryFilter, QueryTrait,
    TransactionTrait,
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
fn pending_files_query_exposes_partial_index_predicate_to_generic_plans() {
    let statement =
        query::pending_files_query(1_000).build(DbBackend::Postgres);
    let sql = statement.sql;
    let values = statement.values.expect("query should bind its limit").0;

    assert!(sql.contains(r#""file_entry"."kind" = 'file'"#), "{sql}");
    assert!(sql.contains(r#""file_entry"."analyzed" = FALSE"#), "{sql}");
    assert!(sql.contains("LIMIT $1"), "{sql}");
    assert_eq!(values.len(), 1, "{sql}");
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
    let root_id = Uuid::now_v7();
    let now = Utc::now().naive_utc();
    file_entry::ActiveModel {
        id: Set(root_id),
        device_id: Set(device_id),
        parent_id: Set(None),
        kind: Set(FileEntryKind::Directory),
        name: Set("C:\\".to_string()),
        absolute_path: Set(None),
        hierarchy_path: Set(hierarchy_label(root_id)),
        mime_type: Set(None),
        extension: Set(None),
        file_metadata_created_at: Set(None),
        file_metadata_modified_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        content_path: Set(None),
        analyzed: NotSet,
    }
    .insert(file_db)
    .await
    .unwrap();

    let root_path = hierarchy_label(root_id);
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
            analyzed: NotSet,
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
        &env.dbx,
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
        .all(&env.dbx)
        .await
        .unwrap()
}

#[tokio::test]
#[serial_test::serial]
async fn shared_rule_cache_reuses_and_refreshes_compiled_rules() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let tag = bl::create_tag(&env.dbx, "Кеш правил".to_string())
        .await
        .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    let cache = worker::RuleCache::default();

    let first_transaction = env.dbx.begin().await.unwrap();
    let first_rules = cache.load_rules(&first_transaction).await.unwrap();
    first_transaction.commit().await.unwrap();
    assert_eq!(
        analyze(
            &first_rules,
            &file("report.pdf", r"C:\report.pdf", Some("pdf"))
        )
        .matched_tags,
        [tag_id]
    );

    let second_transaction = env.dbx.begin().await.unwrap();
    let second_rules = cache.load_rules(&second_transaction).await.unwrap();
    second_transaction.commit().await.unwrap();
    assert!(
        Arc::ptr_eq(&first_rules, &second_rules),
        "an unchanged DB revision must reuse the compiled rules"
    );

    save_extension_rule(env.as_ref(), tag_id, "txt").await;
    let third_transaction = env.dbx.begin().await.unwrap();
    let third_rules = cache.load_rules(&third_transaction).await.unwrap();
    third_transaction.commit().await.unwrap();
    assert!(
        !Arc::ptr_eq(&second_rules, &third_rules),
        "a committed rule mutation must invalidate every worker cache"
    );
    assert!(analyze(
        &third_rules,
        &file("report.pdf", r"C:\report.pdf", Some("pdf"))
    )
    .matched_tags
    .is_empty());
    assert_eq!(
        analyze(
            &third_rules,
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
    let tag = bl::create_tag(&env.dbx, "Незмінний PDF".to_string())
        .await
        .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    let cache = worker::RuleCache::default();

    assert!(worker::run_tick_with(env.as_ref(), &cache, 1)
        .await
        .unwrap());
    let before = file_links(env.as_ref(), file_id).await.remove(0);
    assert_eq!(
        query::schedule_reanalysis(
            env.file_registry_db().unwrap().connection(),
            Some(device_id),
        )
        .await
        .unwrap(),
        1,
    );

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
    let tag = bl::create_tag(&env.dbx, "Звіти".to_string()).await.unwrap();
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

    assert_eq!(
        query::schedule_reanalysis(
            env.file_registry_db().unwrap().connection(),
            Some(device_id),
        )
        .await
        .unwrap(),
        1,
    );
    assert!(worker::run_tick(env.as_ref()).await.unwrap());
    assert!(file_links(env.as_ref(), file_id).await.is_empty());

    save_extension_rule(env.as_ref(), tag_id, "pdf").await;
    assert_eq!(
        query::schedule_reanalysis(
            env.file_registry_db().unwrap().connection(),
            Some(device_id),
        )
        .await
        .unwrap(),
        1,
    );
    assert!(worker::run_tick(env.as_ref()).await.unwrap());
    assert_eq!(file_links(env.as_ref(), file_id).await.len(), 1);

    bl::archive_tag(&env.dbx, tag_id).await.unwrap();
    assert!(file_links(env.as_ref(), file_id).await.is_empty());
    bl::restore_tag(&env.dbx, tag_id).await.unwrap();
    assert!(!worker::run_tick(env.as_ref()).await.unwrap());
    assert!(file_links(env.as_ref(), file_id).await.is_empty());

    assert_eq!(
        query::schedule_reanalysis(
            env.file_registry_db().unwrap().connection(),
            Some(device_id),
        )
        .await
        .unwrap(),
        1,
    );
    assert!(worker::run_tick(env.as_ref()).await.unwrap());
    assert_eq!(file_links(env.as_ref(), file_id).await.len(), 1);
}
#[tokio::test]
#[serial_test::serial]
async fn rule_test_files_are_persisted_in_order_and_replaced() {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let tag =
        bl::create_tag(&env.dbx, format!("Rule fixtures {}", Uuid::now_v7()))
            .await
            .unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    let first_files = vec![
        RuleTestFile {
            name: "report.pdf".to_string(),
            absolute_path: r"C:\reports\report.pdf".to_string(),
            extension: Some("pdf".to_string()),
        },
        RuleTestFile {
            name: "notes.txt".to_string(),
            absolute_path: r"C:\reports\notes.txt".to_string(),
            extension: None,
        },
    ];

    let response = bl::test_rule(
        &env.dbx,
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
    assert_eq!(
        bl::list_tag_test_files(&env.dbx, tag_id).await.unwrap(),
        first_files
    );

    let replacement = vec![RuleTestFile {
        name: "replacement.docx".to_string(),
        absolute_path: "/archive/replacement.docx".to_string(),
        extension: Some("docx".to_string()),
    }];
    bl::test_rule(&env.dbx, tag_id, None, replacement.clone())
        .await
        .unwrap();
    assert_eq!(
        bl::list_tag_test_files(&env.dbx, tag_id).await.unwrap(),
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
    let tag = bl::create_tag(&env.dbx, "PDF".to_string()).await.unwrap();
    let tag_id = Uuid::parse_str(&tag.id).unwrap();
    save_extension_rule(env.as_ref(), tag_id, "pdf").await;

    let cache = worker::RuleCache::default();
    let (first, second) = tokio::join!(
        worker::run_tick_with(env.as_ref(), &cache, 1),
        worker::run_tick_with(env.as_ref(), &cache, 1),
    );
    let processed = [first.unwrap(), second.unwrap()];
    assert_eq!(processed, [true, true]);
    assert!(!worker::run_tick_with(env.as_ref(), &cache, 1)
        .await
        .unwrap());

    let analyzed = file_entry::Entity::find()
        .filter(file_entry::Column::Id.is_in(file_ids.iter().copied()))
        .all(env.file_registry_db().unwrap().connection())
        .await
        .unwrap();
    assert_eq!(analyzed.len(), 2);
    assert!(analyzed.iter().all(|file| file.analyzed));

    let links = device_file_tag::Entity::find()
        .filter(device_file_tag::Column::TagId.eq(tag_id))
        .all(&env.dbx)
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
        &env.dbx,
        Uuid::now_v7(),
        "Invalid direct write".to_string(),
    )
    .await
    .unwrap();
    let mut tag: analytics_tag::ActiveModel = tag.into();
    tag.rule_expression = Set(Some(json!({"op": "unknown"})));
    let tag = tag.update(&env.dbx).await.unwrap();

    let error = worker::run_tick(env.as_ref()).await.unwrap_err();
    assert!(error.to_string().contains(&tag.id.to_string()));
    let file = file_entry::Entity::find_by_id(file_id)
        .one(env.file_registry_db().unwrap().connection())
        .await
        .unwrap()
        .unwrap();
    assert!(!file.analyzed);
    assert!(file_links(env.as_ref(), file_id).await.is_empty());
}
