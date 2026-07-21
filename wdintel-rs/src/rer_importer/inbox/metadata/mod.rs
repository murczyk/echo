use crate::entities::*;
use crate::rer_importer::highlight::CNCallsign;
use crate::rer_importer::inbox::metadata::parser::*;
use crate::rer_importer::inbox::metadata::types::*;
use crate::types::*;
use chrono::NaiveDateTime;
use futures_util::TryStreamExt;
use sea_orm::*;
use std::ops::Range;

pub mod oneoff;
mod parser;
pub mod types;

pub(crate) use parser::{
    is_metadata_line, normalize_metadata_digits, normalize_metadata_value,
};

pub(crate) fn parse_metadata_text_callsigns(body: &str) -> Vec<String> {
    dedupe_text_callsigns_case_insensitive(
        body.lines()
            .filter(|line| is_metadata_line(line))
            .flat_map(parse_metadata)
            .flat_map(|metadata| {
                metadata_text_callsigns(
                    metadata.id_name.as_deref(),
                    metadata.cg_name.as_deref(),
                )
            }),
    )
}

pub(crate) fn append_metadata_text_callsigns<I>(
    callsigns: I,
    body: &str,
) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    dedupe_text_callsigns_case_insensitive(
        callsigns
            .into_iter()
            .chain(parse_metadata_text_callsigns(body)),
    )
}

pub(crate) fn non_metadata_line_callsign_etalons<'a, I>(
    callsign_tokens: I,
    body: &str,
) -> Vec<String>
where
    I: IntoIterator<Item = &'a CNCallsign>,
{
    let metadata_line_ranges = metadata_line_ranges(body);
    callsign_tokens
        .into_iter()
        .filter(|callsign| {
            !span_is_in_metadata_line(
                &metadata_line_ranges,
                callsign.begin,
                callsign.end,
            )
        })
        .map(|callsign| callsign.etalon.clone())
        .collect()
}

fn metadata_line_ranges(body: &str) -> Vec<Range<usize>> {
    let mut ranges = vec![];
    let mut line_start = 0;
    for line in body.split_inclusive('\n') {
        let line_len = line.chars().count();
        let line_without_newline = line.strip_suffix('\n').unwrap_or(line);
        let line_without_newline = line_without_newline
            .strip_suffix('\r')
            .unwrap_or(line_without_newline);
        if is_metadata_line(line_without_newline) {
            ranges.push(line_start..line_start + line_len);
        }
        line_start += line_len;
    }
    ranges
}

fn span_is_in_metadata_line(
    metadata_line_ranges: &[Range<usize>],
    begin: usize,
    end: usize,
) -> bool {
    metadata_line_ranges
        .iter()
        .any(|range| begin >= range.start && end <= range.end)
}

pub(crate) fn metadata_text_callsigns(
    sender: Option<&str>,
    receiver: Option<&str>,
) -> Vec<String> {
    dedupe_text_callsigns_case_insensitive(
        [sender, receiver]
            .into_iter()
            .flatten()
            .map(|value| value.to_string()),
    )
}

pub(crate) fn dedupe_text_callsigns_case_insensitive<I>(
    callsigns: I,
) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut result = vec![];
    let mut seen = std::collections::BTreeSet::new();
    for callsign in callsigns {
        let Some(callsign) = normalize_metadata_text_callsign(&callsign) else {
            continue;
        };
        if seen.insert(callsign.to_lowercase()) {
            result.push(callsign);
        }
    }
    result
}

fn normalize_metadata_text_callsign(value: &str) -> Option<String> {
    let value = normalize_metadata_digits(value);
    normalize_metadata_value(&value)
}

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
        let metadata = parse_metadata_asserting_spans("СС:1️⃣4️⃣\nCG:5️⃣0️⃣");
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
        let metadata = parse_metadata_asserting_spans(
            "25.02.2026 12:09:42 F=145.0260 (МГц)
УКХ р/м вБпЛА 121 мсп 68 мсд 6 А 🆓 (ЛИМАН ПЕРШИЙ) СС:1️⃣ CG:5️⃣0️⃣
ID➡️:110(ЯРУС)
ID(CG)⬅️:50📣",
        );
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
    fn parse_metadata_handles_cyrillic_cc_and_emoji_digits3() {
        let metadata = parse_metadata_asserting_spans(
            "25.02.2026 12:09:42 F=145.0260 (МГц)
🔺УКХ р/м НВ підрозділу 151.600 МГц СС: 7 👥: 24538 🔐", // in case we have line like 👥: 24538 🔐 - we treat trimmed value between : and 🔐 as hash id
        );
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("7".to_string()),
                hash_id: Some("24538".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_cyrillic_cc_and_emoji_digits4() {
        let metadata = parse_metadata_asserting_spans(
            "25.02.2026 12:09:42 F=145.0260 (МГц)
🔺УКХ р/м управління рр 128 омсбр 44 АК (ВОВЧАНСЬК, ВІЛЬЧА, ХАРКІВСЬКА ОБЛАСТЬ) CC: 1👥: 80132🔐", // in case we have line like 👥: 24538 🔐 - we treat trimmed value between : and 🔐 as hash id
        );
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("1".to_string()),
                hash_id: Some("80132".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_plain_id_variants_without_arrows() {
        let metadata =
            parse_metadata_asserting_spans("СС:8\nІD:21152\nID(CG):395251");
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
    fn parse_metadata_handles_dmr_arrow_ids_without_colons() {
        let metadata = parse_metadata_asserting_spans(
            "СС:10\nID➡️ 11112222\nID(CG)⬅️ 890840",
        );
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("10".to_string()),
                cg: Some("890840".to_string()),
                id: Some("11112222".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_compact_receiver_id_after_arrow() {
        let metadata = parse_metadata_asserting_spans(
            "СС:10\nID➡️: 3097968\nID(CG)⬅️3187767",
        );
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                cc: Some("10".to_string()),
                cg: Some("3187767".to_string()),
                id: Some("3097968".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_handles_textual_id_after_colon_before_semicolon() {
        let metadata = parse_metadata_asserting_spans(" Id:96МГ1_1; ");
        assert_eq!(
            metadata,
            vec![InboxMetadata {
                id_name: Some("96МГ1_1".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_text_callsigns_returns_sender_and_receiver_names() {
        let callsigns = parse_metadata_text_callsigns(
            "СС:10\nID➡️: 3097968(ЯРУС)\nID(CG)⬅️3187767(СВЕТЛЫЙ)",
        );

        assert_eq!(callsigns, vec!["ЯРУС".to_string(), "СВЕТЛЫЙ".to_string()]);
    }

    #[test]
    fn parse_metadata_text_callsigns_returns_source_id_sender_names() {
        let callsigns = parse_metadata_text_callsigns(
            "SOURCE ID: 123(ЯРУС)\nID відправника: 124(СВЕТЛЫЙ)",
        );

        assert_eq!(callsigns, vec!["ЯРУС".to_string(), "СВЕТЛЫЙ".to_string()]);
    }

    #[test]
    fn parse_metadata_text_callsigns_ignores_numeric_only_metadata() {
        let callsigns = parse_metadata_text_callsigns(
            "СС:10\nID➡️:3097968\nID(CG)⬅️3187767",
        );

        assert!(callsigns.is_empty());
    }

    #[test]
    fn parse_metadata_text_callsigns_ignores_names_in_prose() {
        let callsigns = parse_metadata_text_callsigns(
            "Звичайний текст ID: 120(ЛИС)\nІнший текст CG 121(ВОВК)",
        );

        assert!(callsigns.is_empty());
    }

    #[test]
    fn append_metadata_text_callsigns_appends_text_and_dedupes() {
        let callsigns = append_metadata_text_callsigns(
            vec!["АЛЬФА".to_string(), "ярус".to_string()],
            "ID➡️:110( ЯРУС )\nID(CG)⬅️:50( СВЕТЛЫЙ )",
        );

        assert_eq!(
            callsigns,
            vec![
                "АЛЬФА".to_string(),
                "ярус".to_string(),
                "СВЕТЛЫЙ".to_string()
            ]
        );
    }

    #[test]
    fn non_metadata_line_callsign_etalons_drops_metadata_header_tokens() {
        let body = "ID➡️:110(ЯРУС)\nID(CG)⬅️:50(СВЕТЛЫЙ)\nID поза метаданими";
        let id_header = test_cn_callsign(body, "ID", "id");
        let yarus_header = test_cn_callsign(body, "ЯРУС", "ярус");
        let id_body = test_cn_callsign(body, "ID поза", "id");

        let callsigns = non_metadata_line_callsign_etalons(
            [&id_header, &yarus_header, &id_body],
            body,
        );

        assert_eq!(callsigns, vec!["id".to_string()]);
        assert_eq!(
            append_metadata_text_callsigns(callsigns, body),
            vec!["id".to_string(), "ЯРУС".to_string(), "СВЕТЛЫЙ".to_string(),]
        );
    }

    #[test]
    fn append_metadata_text_callsigns_restores_source_id_names() {
        let body = "SOURCE ID: 123(ЯРУС)";
        let yarus_header = test_cn_callsign(body, "ЯРУС", "ярус");

        let callsigns =
            non_metadata_line_callsign_etalons([&yarus_header], body);

        assert!(callsigns.is_empty());
        assert_eq!(
            append_metadata_text_callsigns(callsigns, body),
            vec!["ЯРУС".to_string()]
        );
    }

    #[test]
    fn metadata_text_callsigns_trim_and_dedupe_case_insensitively() {
        let callsigns = metadata_text_callsigns(Some(" ЯРУС "), Some("ярус"));

        assert_eq!(callsigns, vec!["ЯРУС".to_string()]);
    }

    #[test]
    fn parse_metadata_handles_hash_id_with_prefix() {
        let metadata = parse_metadata_asserting_spans(" Хеш ID: 2324d327 ");
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
        let metadata = parse_metadata_line_asserting_spans("ХЕШ ID: 2324D327");
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
        let metadata = parse_metadata_asserting_spans(" source id: 0 ");
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
        let metadata = parse_metadata_asserting_spans(
            "CC:23 SOURCE ID: 1, 33; GROUP ID: 6",
        );
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
    fn parse_metadata_shares_trailing_name_across_source_id_list() {
        for body in ["SOURCE ID: 1, 33 (ЯРУС)", "ID➡️: 1, 33 (ЯРУС)"]
        {
            assert_eq!(
                parse_metadata_asserting_spans(body),
                vec![
                    InboxMetadata {
                        id: Some("1".to_string()),
                        id_name: Some("ЯРУС".to_string()),
                        ..Default::default()
                    },
                    InboxMetadata {
                        id: Some("33".to_string()),
                        id_name: Some("ЯРУС".to_string()),
                        ..Default::default()
                    },
                ]
            );
        }
    }

    #[test]
    fn parse_metadata_handles_named_source_id_list() {
        assert_eq!(
            parse_metadata_asserting_spans("SOURCE ID: 1 (A), 2 (B)"),
            vec![
                InboxMetadata {
                    id: Some("1".to_string()),
                    id_name: Some("A".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    id: Some("2".to_string()),
                    id_name: Some("B".to_string()),
                    ..Default::default()
                },
            ]
        );
    }

    #[test]
    fn parse_metadata_does_not_match_source_id_inside_word() {
        assert!(parse_metadata_checked("RESOURCE ID: 1, 2").is_empty());
    }

    #[test]
    fn parse_metadata_handles_sc_transcript_header() {
        let metadata = parse_metadata_asserting_spans(
            r#"27.06.2026 20:37:23
Отримано з поста "SC2"
*138.375*
СС: 5
ID➡️: 261, 12106, 1454, 2539
ID(CG)⬅️: 8584772
(УКХ р/м вБпЛа 121 мсп 68 мсд 6 А 🔑 (ЛИМАН ПЕРШИЙ) СС:5️⃣📟📣 138.375)
Позивні: `12106=СТОЛИЦА, 1454=ШУСТРЫЙ`"#,
        );

        assert_eq!(
            metadata,
            vec![
                InboxMetadata {
                    cc: Some("5".to_string()),
                    cg: Some("8584772".to_string()),
                    id: Some("261".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cc: Some("5".to_string()),
                    cg: Some("8584772".to_string()),
                    id: Some("12106".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cc: Some("5".to_string()),
                    cg: Some("8584772".to_string()),
                    id: Some("1454".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cc: Some("5".to_string()),
                    cg: Some("8584772".to_string()),
                    id: Some("2539".to_string()),
                    ..Default::default()
                }
            ]
        );
    }

    #[test]
    fn parse_metadata_handles_named_source_ids_in_list() {
        let body = "СС: 11\nID➡️: 2070 (БАНАН), 6005 (ОДНОРАЗИК), 1007, 1991\nID(CG)⬅️: 906090 (ЛУНТИК)";
        let metadata = parse_metadata_asserting_spans(body);

        assert_eq!(
            metadata,
            vec![
                InboxMetadata {
                    cc: Some("11".to_string()),
                    cg: Some("906090".to_string()),
                    cg_name: Some("ЛУНТИК".to_string()),
                    id: Some("2070".to_string()),
                    id_name: Some("БАНАН".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cc: Some("11".to_string()),
                    cg: Some("906090".to_string()),
                    cg_name: Some("ЛУНТИК".to_string()),
                    id: Some("6005".to_string()),
                    id_name: Some("ОДНОРАЗИК".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cc: Some("11".to_string()),
                    cg: Some("906090".to_string()),
                    cg_name: Some("ЛУНТИК".to_string()),
                    id: Some("1007".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    cc: Some("11".to_string()),
                    cg: Some("906090".to_string()),
                    cg_name: Some("ЛУНТИК".to_string()),
                    id: Some("1991".to_string()),
                    ..Default::default()
                },
            ]
        );
        assert_eq!(
            append_metadata_text_callsigns(Vec::new(), body),
            vec![
                "БАНАН".to_string(),
                "ОДНОРАЗИК".to_string(),
                "ЛУНТИК".to_string(),
            ]
        );
    }

    #[test]
    fn parse_metadata_keeps_commas_inside_source_id_names() {
        let metadata = parse_metadata_asserting_spans(
            "ID➡️: 1 (АЛЬФА, РЕЗЕРВ), 2 (БРАВО)",
        );

        assert_eq!(
            metadata,
            vec![
                InboxMetadata {
                    id: Some("1".to_string()),
                    id_name: Some("АЛЬФА, РЕЗЕРВ".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    id: Some("2".to_string()),
                    id_name: Some("БРАВО".to_string()),
                    ..Default::default()
                },
            ]
        );
    }

    #[test]
    fn parse_metadata_handles_keycap_source_ids_in_list() {
        let metadata =
            parse_metadata_asserting_spans("ID➡️: 1️⃣ (АЛЬФА), 2️⃣ (БРАВО)");

        assert_eq!(
            metadata,
            vec![
                InboxMetadata {
                    id: Some("1".to_string()),
                    id_name: Some("АЛЬФА".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    id: Some("2".to_string()),
                    id_name: Some("БРАВО".to_string()),
                    ..Default::default()
                },
            ]
        );
    }

    #[test]
    fn parse_metadata_preserves_source_name_for_unnamed_id_list_parts() {
        let metadata = parse_metadata_asserting_spans("ID: ЯРУС; ID➡️: 1, 2");

        assert_eq!(
            metadata,
            vec![
                InboxMetadata {
                    id: Some("1".to_string()),
                    id_name: Some("ЯРУС".to_string()),
                    ..Default::default()
                },
                InboxMetadata {
                    id: Some("2".to_string()),
                    id_name: Some("ЯРУС".to_string()),
                    ..Default::default()
                },
            ]
        );
    }

    #[test]
    fn parse_metadata_line_handles_source_id_variant() {
        let metadata = parse_metadata_line_asserting_spans("SOURCE ID: 0");
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
        let metadata = parse_metadata_line_asserting_spans(
            "CC:23 SOURCE ID: 1, 33; GROUP ID: 6",
        );
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
        let metadata = parse_metadata_asserting_spans(" group id: 0 ");
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
        let metadata = parse_metadata_asserting_spans(
            "148.490
37U CP 83574 54679
Код кольору: 3
id відправника: 7549484
id отримувача: 3359939
код групи: 1",
        );
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
        let metadata = parse_metadata_asserting_spans(
            "Код кольору: НВ
ID відправника: -
ID отримувача: 3359939
Код групи: -",
        );
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
        let metadata = parse_metadata_asserting_spans(
            "ID відправника: -; ID:123; код групи: НВ",
        );
        assert_eq!(metadata.len(), 1);
        assert_eq!(metadata[0].id.as_deref(), Some("123"));
    }

    #[test]
    fn parse_metadata_line_handles_group_id_variant() {
        let metadata = parse_metadata_line_asserting_spans("GROUP ID: 0");
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
        let metadata = parse_metadata_asserting_spans("CG:10 CG:x:12112027");
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
            parse_metadata_asserting_spans(&message.content),
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
            parse_metadata_asserting_spans("cc:1 cg:10"),
            vec![InboxMetadata {
                cc: Some("1".to_string()),
                cg: Some("10".to_string()),
                ..Default::default()
            }]
        );

        assert_eq!(
            parse_metadata_asserting_spans("id(cg):50"),
            vec![InboxMetadata {
                cg: Some("50".to_string()),
                ..Default::default()
            }]
        );
    }

    #[test]
    fn parse_metadata_ignores_mgrs_coordinates_with_cg_square() {
        assert!(parse_metadata_asserting_spans(
            "Координати: 37U CG 12345 67890"
        )
        .is_empty());
        assert!(parse_metadata_asserting_spans("37UCG1234567890").is_empty());
    }

    #[test]
    fn parse_metadata_splits_on_conflicting_metadata_and_drops_duplicates() {
        let metadata = parse_metadata_asserting_spans(
            "CC:1 CG:10
CC:2 CG:20
CC:1 CG:10",
        );

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
        let metadata = parse_metadata_asserting_spans(
            "ID(CG):50
CG:12112027",
        );

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
        let metadata = parse_metadata_asserting_spans(
            "CC:1 CG:10
CC:1 CG:10
CC:2 CG:20",
        );

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
        assert_metadata_spans("hello cc 545\nID:99", &metadata);

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
        assert_metadata_spans("CC:23 SOURCE ID: 1, 33; GROUP ID: 6", &metadata);

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
                let metadata = parse_metadata_checked(&message.content);
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

        assert!(parse_metadata_checked(&message.content).is_empty());
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

    fn parse_metadata_checked(message: &str) -> Vec<InboxMetadata> {
        let metadata = parse_metadata(message);
        assert_metadata_spans(message, &metadata);
        metadata
    }

    fn parse_metadata_asserting_spans(message: &str) -> Vec<InboxMetadata> {
        metadata_without_spans(parse_metadata_checked(message))
    }

    fn parse_metadata_line_asserting_spans(line: &str) -> Vec<WorkingMetadata> {
        let normalized_line = NormalizedLine::new(line.to_string());
        let metadata = parse_metadata_line(&normalized_line);
        assert_working_metadata_spans(line, &metadata);
        working_metadata_without_spans(metadata)
    }

    fn assert_metadata_spans(message: &str, items: &[InboxMetadata]) {
        for (item_idx, metadata) in items.iter().enumerate() {
            assert_optional_span(
                message,
                item_idx,
                "cc",
                metadata.cc.as_deref(),
                metadata.cc_start_index,
                metadata.cc_end_index,
            );
            assert_optional_span(
                message,
                item_idx,
                "cg",
                metadata.cg.as_deref(),
                metadata.cg_start_index,
                metadata.cg_end_index,
            );
            assert_optional_span(
                message,
                item_idx,
                "cg_name",
                metadata.cg_name.as_deref(),
                metadata.cg_name_start_index,
                metadata.cg_name_end_index,
            );
            assert_optional_span(
                message,
                item_idx,
                "id",
                metadata.id.as_deref(),
                metadata.id_start_index,
                metadata.id_end_index,
            );
            assert_optional_span(
                message,
                item_idx,
                "id_name",
                metadata.id_name.as_deref(),
                metadata.id_name_start_index,
                metadata.id_name_end_index,
            );
            assert_optional_span(
                message,
                item_idx,
                "hash_id",
                metadata.hash_id.as_deref(),
                metadata.hash_id_start_index,
                metadata.hash_id_end_index,
            );
        }
    }

    fn assert_working_metadata_spans(line: &str, items: &[WorkingMetadata]) {
        for (item_idx, metadata) in items.iter().enumerate() {
            assert_matched_value_span(line, item_idx, "cc", &metadata.cc);
            assert_matched_value_span(
                line,
                item_idx,
                "receiver",
                &metadata.receiver,
            );
            assert_matched_value_span(
                line,
                item_idx,
                "receiver_name",
                &metadata.receiver_name,
            );
            assert_matched_value_span(
                line,
                item_idx,
                "receiver_group",
                &metadata.receiver_group,
            );
            assert_matched_value_span(
                line,
                item_idx,
                "receiver_group_name",
                &metadata.receiver_group_name,
            );
            assert_matched_value_span(line, item_idx, "id", &metadata.id);
            assert_matched_value_span(
                line,
                item_idx,
                "id_name",
                &metadata.id_name,
            );
            assert_matched_value_span(
                line,
                item_idx,
                "hash_id",
                &metadata.hash_id,
            );
        }
    }

    fn assert_optional_span(
        source: &str,
        item_idx: usize,
        field: &str,
        value: Option<&str>,
        start_index: Option<i32>,
        end_index: Option<i32>,
    ) {
        match value {
            Some(value) => assert_span_matches_value(
                source,
                item_idx,
                field,
                value,
                start_index,
                end_index,
            ),
            None => {
                assert_eq!(start_index, None, "{item_idx}.{field} start");
                assert_eq!(end_index, None, "{item_idx}.{field} end");
            }
        }
    }

    fn assert_matched_value_span(
        source: &str,
        item_idx: usize,
        field: &str,
        matched_value: &MatchedValue,
    ) {
        match matched_value.value.as_deref() {
            Some(value) => {
                assert!(
                    matched_value.raw_text.is_some(),
                    "{item_idx}.{field} raw_text"
                );
                assert_span_matches_value(
                    source,
                    item_idx,
                    field,
                    value,
                    matched_value.start_index,
                    matched_value.end_index,
                );
            }
            None => {
                assert_eq!(
                    matched_value.start_index, None,
                    "{item_idx}.{field} start"
                );
                assert_eq!(
                    matched_value.end_index, None,
                    "{item_idx}.{field} end"
                );
                assert_eq!(
                    matched_value.raw_text, None,
                    "{item_idx}.{field} raw_text"
                );
            }
        }
    }

    fn assert_span_matches_value(
        source: &str,
        item_idx: usize,
        field: &str,
        value: &str,
        start_index: Option<i32>,
        end_index: Option<i32>,
    ) {
        let start_index =
            start_index.unwrap_or_else(|| panic!("{item_idx}.{field} start"));
        let end_index =
            end_index.unwrap_or_else(|| panic!("{item_idx}.{field} end"));

        assert!(start_index >= 0, "{item_idx}.{field} start");
        assert!(
            end_index >= start_index,
            "{item_idx}.{field} end before start"
        );

        let span_text = slice_chars_inclusive(
            source,
            start_index as usize,
            end_index as usize,
        );
        let normalized_span_text = normalize_span_text(&span_text);
        let normalized_value = normalize_span_text(value);
        let stripped_x_value = normalized_value.strip_prefix("x:");
        assert!(
            normalized_span_text == normalized_value
                || stripped_x_value == Some(normalized_span_text.as_str()),
            "{item_idx}.{field} span {start_index}..={end_index} has {span_text:?}, expected {value:?}"
        );
    }

    fn slice_chars_inclusive(
        source: &str,
        start_index: usize,
        end_index: usize,
    ) -> String {
        source
            .chars()
            .skip(start_index)
            .take(end_index - start_index + 1)
            .collect()
    }

    fn normalize_span_text(value: &str) -> String {
        normalize_metadata_digits(value).trim().to_lowercase()
    }

    fn test_cn_callsign(body: &str, text: &str, etalon: &str) -> CNCallsign {
        let byte_start = body.find(text).unwrap();
        let begin = body[..byte_start].chars().count();
        let end = begin + text.chars().count();
        CNCallsign {
            begin,
            end,
            etalon: etalon.to_string(),
            text: text.to_string(),
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
