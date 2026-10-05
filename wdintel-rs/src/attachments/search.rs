use crate::{h, types::ShortContext};
use sea_orm::{
    sea_query::{Expr, SimpleExpr},
    Value,
};

fn bind(values: &mut Vec<Value>, value: impl Into<Value>) -> String {
    values.push(value.into());
    format!("${}", values.len())
}

pub fn text_predicate(
    query: &str,
    message: &str,
    scope: &str,
    structured: bool,
    values: &mut Vec<Value>,
) -> anyhow::Result<String> {
    anyhow::ensure!(
        query.chars().count() <= crate::config::ATTACHMENT_MAX_QUERY_CHARS,
        "search query too long"
    );
    anyhow::ensure!(
        matches!(scope, "all" | "body" | "attachments" | "document"),
        "invalid search scope"
    );
    let media_filter = media_filter(message, scope);
    let parts =
        crate::rer_importer::analysis::search::parse_search_parts(query)
            .c(h!())?;
    let text_query = if structured {
        parts.ts_query.clone()
    } else {
        // Dedicated attachment queries retain dotted filenames and numeric cells.
        parts
            .ts_query
            .split_whitespace()
            .map(str::to_string)
            .chain(parts.freq.iter().cloned())
            .chain(parts.message_uids.iter().cloned())
            .collect::<Vec<_>>()
            .join(" ")
    };
    let prefixes =
        crate::rer_importer::analysis::search::ts_prefix_query(&text_query)
            .is_some();
    let mut alternatives: Vec<Vec<String>> = vec![vec![]];
    for token in text_query.split_whitespace() {
        if token.eq_ignore_ascii_case("or") {
            alternatives.push(vec![]);
            continue;
        }
        if token.eq_ignore_ascii_case("and") {
            continue;
        }
        let (negative, token) = token
            .strip_prefix('-')
            .map_or((false, token), |s| (true, s));
        if token.is_empty() {
            continue;
        }
        let parameter = bind(values, token);
        let tsquery = if prefixes {
            format!("(plainto_tsquery('russian',{parameter}) || to_tsquery('russian', quote_literal({parameter}) || ':*'))")
        } else {
            format!("plainto_tsquery('russian',{parameter})")
        };
        let name_pattern = bind(
            values,
            format!(
                "%{}%",
                token
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            ),
        );
        let predicate = exists_term(
            message,
            scope,
            &format!("chunk.search_tsv @@ {tsquery}"),
            &format!("media.file_name ilike {name_pattern} escape '\\'"),
            &format!("body_search.search_tsv @@ {tsquery}"),
        );
        alternatives.last_mut().unwrap().push(if negative {
            format!("not ({predicate})")
        } else {
            predicate
        });
    }
    let alternatives: Vec<_> = alternatives
        .into_iter()
        .filter(|a| !a.is_empty())
        .map(|a| format!("({})", a.join(" and ")))
        .collect();
    let mut filters = vec![];
    if !alternatives.is_empty() {
        filters.push(format!("({})", alternatives.join(" or ")));
    }
    for (negative, pattern) in parts
        .ilike
        .into_iter()
        .map(|p| (false, p))
        .chain(parts.not_ilike.into_iter().map(|p| (true, p)))
    {
        let parameter = bind(values, pattern);
        let body = if matches!(scope, "attachments" | "document") {
            "false".into()
        } else {
            format!("exists(select 1 from sigint_inbox_item literal_item where literal_item.id={message} and coalesce(literal_item.body_noheader->>'body','') ilike {parameter} escape '\\')")
        };
        let attachment = if scope == "body" {
            "false".into()
        } else {
            format!("exists(select 1 from signal_message_media media where {media_filter} and (coalesce(media.file_name,'') ilike {parameter} escape '\\' or exists(select 1 from attachment_chunk chunk join attachment_document doc on doc.media_id=chunk.media_id and doc.revision=chunk.revision where chunk.media_id=media.id and (chunk.text ilike {parameter} escape '\\' or chunk.member ilike {parameter} escape '\\' or chunk.summary ilike {parameter} escape '\\'))))")
        };
        filters.push(format!(
            "{}({body} or {attachment})",
            if negative { "not " } else { "" }
        ));
    }
    Ok(if filters.is_empty() {
        "true".into()
    } else {
        filters.join(" and ")
    })
}

fn exists_term(
    message: &str,
    scope: &str,
    chunk: &str,
    filename: &str,
    body: &str,
) -> String {
    let mut sources = Vec::new();
    if !matches!(scope, "attachments" | "document") {
        sources.push(format!(
            "select body_search.id from sigint_search body_search where {body}"
        ));
    }
    if scope != "body" {
        let key = if scope == "document" {
            "media.id"
        } else {
            "media.signal_message_id"
        };
        sources.push(format!(
            "select {key} from signal_message_media media where {filename}"
        ));
        sources.push(format!("select {key} from attachment_chunk chunk join attachment_document doc on doc.media_id=chunk.media_id and doc.revision=chunk.revision join signal_message_media media on media.id=chunk.media_id where {chunk}"));
    }
    format!("{message} in ({})", sources.join(" union "))
}

pub fn message_filter(query: &str, scope: &str) -> anyhow::Result<SimpleExpr> {
    let mut values = Vec::new();
    let sql =
        text_predicate(query, "signal_message.id", scope, true, &mut values)
            .c(h!())?;
    Ok(Expr::cust_with_values(sql, values))
}

fn media_filter(message: &str, scope: &str) -> String {
    if scope == "document" {
        format!("media.id={message}")
    } else {
        format!("media.signal_message_id={message}")
    }
}
