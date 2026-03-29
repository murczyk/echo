use crate::entities::*;
use crate::rer_importer::inbox::metadata::parser::*;
use crate::rer_importer::inbox::metadata::types::*;
use crate::types::*;
use chrono::NaiveDateTime;
use futures_util::TryStreamExt;
use sea_orm::*;

pub mod oneoff;
mod parser;
pub mod types;

pub async fn refresh_metadata_for_body<'a, 'async_trait, C>(
    sigint_inbox_item_id: i64,
    body: &str,
    txn: &'a C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    sigint_inbox_item_metadata::Entity::delete_many()
        .filter(
            sigint_inbox_item_metadata::Column::SigintInboxItemId
                .eq(sigint_inbox_item_id),
        )
        .exec(txn)
        .await
        .c(h!())?;
    let entries = parse_metadata(body);
    let mut new_entries = vec![];
    for e in entries {
        new_entries.push(sigint_inbox_item_metadata::ActiveModel {
            id: NotSet,
            sigint_inbox_item_id: Set(sigint_inbox_item_id),
            color_code: Set(e.cc),
            color_code_start_index: Set(e.cc_start_index),
            color_code_end_index: Set(e.cc_end_index),
            call_group_id: Set(e.cg),
            call_group_id_start_index: Set(e.cg_start_index),
            call_group_id_end_index: Set(e.cg_end_index),
            call_group_name: Set(e.cg_name),
            call_group_name_start_index: Set(e.cg_name_start_index),
            call_group_name_end_index: Set(e.cg_name_end_index),
            sender_id: Set(e.id),
            sender_id_start_index: Set(e.id_start_index),
            sender_id_end_index: Set(e.id_end_index),
            sender_name: Set(e.id_name),
            sender_name_start_index: Set(e.id_name_start_index),
            sender_name_end_index: Set(e.id_name_end_index),
            hash_id: Set(e.hash_id),
            hash_id_start_index: Set(e.hash_id_start_index),
            hash_id_end_index: Set(e.hash_id_end_index),
            created_at: NotSet,
        });
    }
    if new_entries.is_empty() {
        return Ok(());
    }
    sigint_inbox_item_metadata::Entity::insert_many(new_entries)
        .exec(txn)
        .await
        .c(h!())?;
    Ok(())
}

pub async fn refresh_metadata<'a, 'async_trait, C>(
    sigint_inbox_item_id: i64,
    dbx: &'a C,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let body = signal_message::Entity::find_by_id(sigint_inbox_item_id)
        .select_only()
        .column(signal_message::Column::Body)
        .into_tuple::<String>()
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())?;
    refresh_metadata_for_body(sigint_inbox_item_id, &body, dbx).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rer_importer::inbox::metadata::parser::parse_metadata;
    use serde::Deserialize;
    use std::fs;
    use std::path::PathBuf;

    #[derive(Debug, Deserialize)]
    struct FixtureMessage {
        id: i64,
        content: String,
    }

    #[test]
    fn parse_metadata_handles_cyrillic_cc_and_emoji_digits() {
        let metadata =
            metadata_without_spans(parse_metadata("СС:1️⃣4️⃣\nCG:5️⃣0️⃣"));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("14".to_string()),
                cg: Some("50".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_cyrillic_cc_and_emoji_digits2() {
        let metadata = metadata_without_spans(parse_metadata(
            "25.02.2026 12:09:42 F=145.0260 (МГц)
УКХ р/м вБпЛА 121 мсп 68 мсд 6 А 🆓 (ЛИМАН ПЕРШИЙ) СС:1️⃣ CG:5️⃣0️⃣
ID➡️:110(ЯРУС)
ID(CG)⬅️:50📣",
        ));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("1".to_string()),
                cg: Some("50".to_string()),
                id: Some("110".to_string()),
                id_name: Some("ЯРУС".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_plain_id_variants_without_arrows() {
        let metadata = metadata_without_spans(parse_metadata(
            "СС:8\nІD:21152\nID(CG):395251",
        ));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("8".to_string()),
                cg: Some("395251".to_string()),
                id: Some("21152".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_textual_id_after_colon_before_semicolon() {
        let metadata = metadata_without_spans(parse_metadata(" Id:96МГ1_1; "));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                id_name: Some("96МГ1_1".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_hash_id_with_prefix() {
        let metadata =
            metadata_without_spans(parse_metadata(" Хеш ID: 2324d327 "));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                hash_id: Some("2324d327".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_line_handles_hash_id_with_prefix() {
        let metadata = working_metadata_without_spans(parse_metadata_line(
            &NormalizedLine::new("ХЕШ ID: 2324D327".to_string()),
        ));
        assert_eq!(
            metadata,
            vec![WorkingMetadata {
                hash_id: matched_value("2324d327"),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_source_id_variant() {
        let metadata = metadata_without_spans(parse_metadata(" source id: 0 "));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                id: Some("0".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_multiple_source_ids_variant() {
        let metadata = metadata_without_spans(parse_metadata(
            "CC:23 SOURCE ID: 1, 33; GROUP ID: 6",
        ));
        assert_eq!(
            metadata,
            vec![
                InboxMetadata {
                    cc: Some("23".to_string()),
                    cg: Some("6".to_string()),
                    id: Some("1".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cc: Some("23".to_string()),
                    cg: Some("6".to_string()),
                    id: Some("33".to_string()),
                    ..Default::default()
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_line_handles_source_id_variant() {
        let metadata = working_metadata_without_spans(parse_metadata_line(
            &NormalizedLine::new("SOURCE ID: 0".to_string()),
        ));
        assert_eq!(
            metadata,
            vec![WorkingMetadata {
                id: matched_value("0"),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_line_handles_multiple_source_ids_variant() {
        let metadata = working_metadata_without_spans(parse_metadata_line(
            &NormalizedLine::new(
                "CC:23 SOURCE ID: 1, 33; GROUP ID: 6".to_string(),
            ),
        ));
        assert_eq!(
            metadata,
            vec![
                WorkingMetadata {
                    cc: matched_value("23"),
                    id: matched_value("1, 33"),
                    ..Default::default()
                },
                WorkingMetadata {
                    receiver_group: matched_value("6"),
                    ..Default::default()
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_handles_group_id_variant() {
        let metadata = metadata_without_spans(parse_metadata(" group id: 0 "));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cg: Some("0".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_new_sigint_optional_fields_format() {
        let metadata = metadata_without_spans(parse_metadata(
            "148.490
37U CP 83574 54679
Код кольору: 3
id відправника: 7549484
id отримувача: 3359939
код групи: 1",
        ));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("3".to_string()),
                id: Some("7549484".to_string()),
                cg: Some("1".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_skips_new_sigint_optional_fields_with_no_value_markers() {
        let metadata = metadata_without_spans(parse_metadata(
            "Код кольору: НВ
ID відправника: -
ID отримувача: 3359939
Код групи: -",
        ));
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cg: Some("3359939".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_keeps_regular_id_when_optional_sender_marker_is_blank() {
        let metadata = metadata_without_spans(parse_metadata(
            "ID відправника: -; ID:123; код групи: НВ",
        ));
        assert_eq!(metadata.len(), 1);
        assert_eq!(metadata[0].id.as_deref(), Some("123"));
    }

    #[test]
    fn parse_metadata_line_handles_group_id_variant() {
        let metadata = working_metadata_without_spans(parse_metadata_line(
            &NormalizedLine::new("GROUP ID: 0".to_string()),
        ));
        assert_eq!(
            metadata,
            vec![
                WorkingMetadata::default(),
                WorkingMetadata {
                    receiver_group: matched_value("0"),
                    ..Default::default()
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_handles_double_cg_ocr_variant() {
        let metadata =
            metadata_without_spans(parse_metadata("CG:10 CG:x:12112027"));
        assert_eq!(
            metadata,
            vec![
                InboxMetadata {
                    cg: Some("10".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cg: Some("x:12112027".to_string()),
                    ..Default::default()
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_handles_receiver_group_x_from_fixture_message() {
        let message = load_fixture_message(14627919);

        assert_eq!(
            metadata_without_spans(parse_metadata(&message.content)),
            vec![
                InboxMetadata {
                    cg: Some("10".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cg: Some("x:12112027".to_string()),
                    ..Default::default()
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_handles_lowercase_cg_forms() {
        assert_eq!(
            metadata_without_spans(parse_metadata("cc:1 cg:10")),
            vec![InboxMetadata {
                cc: Some("1".to_string()),
                cg: Some("10".to_string()),
                ..Default::default()
            }]
        );

        assert_eq!(
            metadata_without_spans(parse_metadata("id(cg):50")),
            vec![InboxMetadata {
                cg: Some("50".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_splits_on_conflicting_metadata_and_drops_duplicates() {
        let metadata = metadata_without_spans(parse_metadata(
            "CC:1 CG:10
CC:2 CG:20
CC:1 CG:10",
        ));

        assert_eq!(metadata.len(), 2);
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("1".to_string()),
            cg: Some("10".to_string()),
            ..Default::default()
        }));
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("2".to_string()),
            cg: Some("20".to_string()),
            ..Default::default()
        }));
    }

    #[test]
    fn parse_metadata_prefers_receiver_group_over_receiver() {
        let metadata = metadata_without_spans(parse_metadata(
            "ID(CG):50
CG:12112027",
        ));

        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cg: Some("12112027".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_splits_on_conflicting_metadata_and_drops_duplicates2() {
        let metadata = metadata_without_spans(parse_metadata(
            "CC:1 CG:10
CC:1 CG:10
CC:2 CG:20",
        ));

        assert_eq!(metadata.len(), 2);
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("1".to_string()),
            cg: Some("10".to_string()),
            ..Default::default()
        }));
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("2".to_string()),
            cg: Some("20".to_string()),
            ..Default::default()
        }));
    }

    #[test]
    fn parse_metadata_tracks_global_inclusive_spans() {
        let metadata = parse_metadata("hello cc 545\nID:99");

        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("545".to_string()),
                cc_start_index: Some(9),
                cc_end_index: Some(11),
                id: Some("99".to_string()),
                id_start_index: Some(16),
                id_end_index: Some(17),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_tracks_spans_for_split_source_ids() {
        let metadata = parse_metadata("CC:23 SOURCE ID: 1, 33; GROUP ID: 6");

        assert_eq!(metadata.len(), 2);
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("23".to_string()),
            cc_start_index: Some(3),
            cc_end_index: Some(4),
            cg: Some("6".to_string()),
            cg_start_index: Some(34),
            cg_end_index: Some(34),
            id: Some("1".to_string()),
            id_start_index: Some(17),
            id_end_index: Some(17),
            ..Default::default()
        }));
        assert!(metadata.contains(&InboxMetadata {
            cc: Some("23".to_string()),
            cc_start_index: Some(3),
            cc_end_index: Some(4),
            cg: Some("6".to_string()),
            cg_start_index: Some(34),
            cg_end_index: Some(34),
            id: Some("33".to_string()),
            id_start_index: Some(20),
            id_end_index: Some(21),
            ..Default::default()
        }));
    }

    #[test]
    fn parse_metadata_extracts_some_value_from_fixture_messages() {
        let messages = load_fixture_messages();
        let missing_metadata = messages
            .into_iter()
            .filter(|message| message.id != 14677154)
            .filter_map(|message| {
                let metadata = parse_metadata(&message.content);
                (metadata.is_empty()
                    || metadata
                        .iter()
                        .any(|item| !metadata_has_some_value(item)))
                .then_some(message.id)
            })
            .collect::<Vec<_>>();

        assert!(
            missing_metadata.is_empty(),
            "messages without parsed metadata: {missing_metadata:?}"
        );
    }

    #[test]
    fn parse_metadata_keeps_known_blank_cc_fixture_message_empty() {
        let message = load_fixture_messages()
            .into_iter()
            .find(|message| message.id == 14677154)
            .expect("fixture message 14677154");

        assert!(parse_metadata(&message.content).is_empty());
    }

    fn load_fixture_messages() -> Vec<FixtureMessage> {
        let fixture_path = fixture_path();
        let fixture = fs::read_to_string(&fixture_path).unwrap_or_else(|err| {
            panic!("failed to read {fixture_path:?}: {err}")
        });
        fixture
            .lines()
            .filter(|line| !line.trim().is_empty())
            .filter(|line| line.trim() != "json_build_object")
            .map(parse_fixture_message)
            .collect()
    }

    fn load_fixture_message(id: i64) -> FixtureMessage {
        load_fixture_messages()
            .into_iter()
            .find(|message| message.id == id)
            .unwrap_or_else(|| panic!("fixture message {id}"))
    }

    fn parse_fixture_message(line: &str) -> FixtureMessage {
        let json = line
            .trim()
            .strip_prefix('"')
            .and_then(|line| line.strip_suffix('"'))
            .expect("quoted sql json row")
            .replace("\"\"", "\"");

        serde_json::from_str(&json)
            .unwrap_or_else(|err| panic!("failed to parse fixture row: {err}"))
    }

    fn fixture_path() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../deploy/message_with_metadata.json")
    }

    fn metadata_has_some_value(metadata: &InboxMetadata) -> bool {
        metadata.cc.is_some()
            || metadata.cg.is_some()
            || metadata.cg_name.as_ref().is_some_and(|src| !src.is_empty())
            || metadata.id.is_some()
            || metadata
                .id_name
                .as_ref()
                .is_some_and(|dest| !dest.is_empty())
            || metadata.hash_id.is_some()
    }

    fn matched_value(value: &str) -> MatchedValue {
        MatchedValue {
            value: Some(value.to_string()),
            ..Default::default()
        }
    }

    fn metadata_without_spans(items: Vec<InboxMetadata>) -> Vec<InboxMetadata> {
        items
            .into_iter()
            .map(|mut item| {
                item.cc_start_index = None;
                item.cc_end_index = None;
                item.cg_start_index = None;
                item.cg_end_index = None;
                item.cg_name_start_index = None;
                item.cg_name_end_index = None;
                item.id_start_index = None;
                item.id_end_index = None;
                item.id_name_start_index = None;
                item.id_name_end_index = None;
                item.hash_id_start_index = None;
                item.hash_id_end_index = None;
                item
            })
            .collect()
    }

    fn working_metadata_without_spans(
        items: Vec<WorkingMetadata>,
    ) -> Vec<WorkingMetadata> {
        items
            .into_iter()
            .map(clear_working_metadata_spans)
            .collect()
    }

    fn clear_working_metadata_spans(
        mut metadata: WorkingMetadata,
    ) -> WorkingMetadata {
        clear_matched_value_spans(&mut metadata.cc);
        clear_matched_value_spans(&mut metadata.receiver);
        clear_matched_value_spans(&mut metadata.receiver_name);
        clear_matched_value_spans(&mut metadata.receiver_group);
        clear_matched_value_spans(&mut metadata.receiver_group_name);
        clear_matched_value_spans(&mut metadata.id);
        clear_matched_value_spans(&mut metadata.id_name);
        clear_matched_value_spans(&mut metadata.hash_id);
        metadata
    }

    fn clear_matched_value_spans(value: &mut MatchedValue) {
        value.start_index = None;
        value.end_index = None;
        value.raw_text = None;
    }
}
