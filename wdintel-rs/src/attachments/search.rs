use crate::rer_importer::types::AnalysisSearchMode;
use crate::{h, types::ShortContext};
use sea_orm::{
    sea_query::{Expr, SimpleExpr},
    Value,
};

fn bind(values: &mut Vec<Value>, value: impl Into<Value>) -> String {
    values.push(value.into());
    format!("${}", values.len())
}

fn term_tsquery(
    token: &str,
    prefixes: bool,
    values: &mut Vec<Value>,
    correlated: bool,
) -> String {
    let parameter = bind(values, token);
    let query = if prefixes {
        format!("(plainto_tsquery('russian',{parameter}) || to_tsquery('russian', quote_literal({parameter}) || ':*'))")
    } else {
        format!("plainto_tsquery('russian',{parameter})")
    };
    if correlated {
        format!("(select {query})")
    } else {
        query
    }
}

pub(crate) fn chunk_terms_predicate_with_mode(
    query: &str,
    search_mode: Option<AnalysisSearchMode>,
    values: &mut Vec<Value>,
) -> anyhow::Result<String> {
    let search_mode = search_mode.unwrap_or_default();
    anyhow::ensure!(
        query.chars().count() <= crate::config::ATTACHMENT_MAX_QUERY_CHARS,
        "search query too long"
    );
    let parts =
        crate::rer_importer::analysis::search::parse_search_parts(query)
            .c(h!())?;
    let prefixes =
        crate::rer_importer::analysis::search::ts_prefix_query(&parts.ts_query)
            .is_some();
    let mut predicates = Vec::new();
    for token in parts.ts_query.split_whitespace() {
        if token.eq_ignore_ascii_case("or") || token.eq_ignore_ascii_case("and")
        {
            continue;
        }
        let token = token.strip_prefix('-').unwrap_or(token);
        if !token.is_empty() {
            if search_mode == AnalysisSearchMode::Fuzzy {
                let tsquery = term_tsquery(token, prefixes, values, false);
                predicates.push(format!("chunk.search_tsv @@ {tsquery}"));
            } else {
                predicates.push(chunk_literal_predicate(
                    &literal_pattern(token),
                    search_mode,
                    values,
                ));
            }
        }
    }
    for pattern in parts.ilike.into_iter().chain(parts.not_ilike) {
        predicates.push(chunk_literal_predicate(&pattern, search_mode, values));
    }
    Ok(if predicates.is_empty() {
        "false".into()
    } else {
        predicates.join(" or ")
    })
}

pub fn text_predicate(
    query: &str,
    message: &str,
    scope: &str,
    structured: bool,
    values: &mut Vec<Value>,
) -> anyhow::Result<String> {
    text_predicate_with_correlation(
        query, message, scope, structured, values, false, None, false,
    )
    .c(h!())
}

#[allow(clippy::too_many_arguments)]
fn text_predicate_with_correlation(
    query: &str,
    message: &str,
    scope: &str,
    structured: bool,
    values: &mut Vec<Value>,
    correlated: bool,
    search_mode: Option<AnalysisSearchMode>,
    direct_body: bool,
) -> anyhow::Result<String> {
    let search_mode = search_mode.unwrap_or_default();
    anyhow::ensure!(
        query.chars().count() <= crate::config::ATTACHMENT_MAX_QUERY_CHARS,
        "search query too long"
    );
    anyhow::ensure!(
        matches!(scope, "all" | "body" | "attachments" | "document"),
        "invalid search scope"
    );
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
        let predicate = if search_mode == AnalysisSearchMode::Fuzzy {
            let tsquery = term_tsquery(token, prefixes, values, correlated);
            let name_pattern = bind(values, literal_pattern(token));
            exists_term(
                message,
                scope,
                &format!("chunk.search_tsv @@ {tsquery}"),
                &format!("media.file_name ilike {name_pattern} escape '\\'"),
                &format!("body_search.search_tsv @@ {tsquery}"),
                correlated,
            )
        } else {
            message_literal_predicate(
                message,
                scope,
                &literal_pattern(token),
                search_mode,
                values,
                direct_body,
            )
        };
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
        let predicate = message_literal_predicate(
            message,
            scope,
            &pattern,
            search_mode,
            values,
            direct_body,
        );
        filters.push(format!(
            "{}({predicate})",
            if negative { "not " } else { "" }
        ));
    }
    Ok(if filters.is_empty() {
        "true".into()
    } else {
        filters.join(" and ")
    })
}

fn literal_pattern(token: &str) -> String {
    format!(
        "%{}%",
        token
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

fn exact_pattern(pattern: &str) -> String {
    let expression = literal_expression(pattern);
    format!("(^|[^[:alnum:]_]){expression}($|[^[:alnum:]_])")
}

fn literal_expression(pattern: &str) -> String {
    let pattern = pattern.strip_prefix('%').unwrap_or(pattern);
    let pattern = pattern.strip_suffix('%').unwrap_or(pattern);
    let mut expression = String::new();
    let mut escaped = false;
    for ch in pattern.chars() {
        if escaped {
            expression.push_str(&regex::escape(&ch.to_string()));
            escaped = false;
        } else {
            match ch {
                '\\' => escaped = true,
                '%' => expression.push_str(".*"),
                '_' => expression.push('.'),
                _ => expression.push_str(&regex::escape(&ch.to_string())),
            }
        }
    }
    expression
}

pub(crate) fn message_headline_pattern(
    query: &str,
    search_mode: AnalysisSearchMode,
) -> anyhow::Result<Option<String>> {
    let parts =
        crate::rer_importer::analysis::search::parse_search_parts(query)
            .c(h!())?;
    let patterns = parts
        .ts_query
        .split_whitespace()
        .filter(|token| {
            !token.starts_with('-')
                && !token.eq_ignore_ascii_case("or")
                && !token.eq_ignore_ascii_case("and")
        })
        .map(literal_pattern)
        .chain(parts.ilike)
        .map(|pattern| {
            let expression = literal_expression(&pattern);
            if search_mode == AnalysisSearchMode::Exact {
                format!("(?<![[:alnum:]_])(?:{expression})(?![[:alnum:]_])")
            } else {
                format!("(?:{expression})")
            }
        })
        .collect::<Vec<_>>();
    Ok(if patterns.is_empty() {
        None
    } else {
        Some(patterns.join("|"))
    })
}

fn literal_operator(
    pattern: &str,
    search_mode: AnalysisSearchMode,
    values: &mut Vec<Value>,
) -> String {
    if search_mode == AnalysisSearchMode::Exact {
        let parameter = bind(values, exact_pattern(pattern));
        format!("~* {parameter}")
    } else {
        let parameter = bind(values, pattern);
        format!("ilike {parameter} escape '\\'")
    }
}

fn chunk_literal_predicate(
    pattern: &str,
    search_mode: AnalysisSearchMode,
    values: &mut Vec<Value>,
) -> String {
    let operator = literal_operator(pattern, search_mode, values);
    format!("(chunk.text {operator} or chunk.member {operator} or chunk.summary {operator})")
}

fn message_literal_predicate(
    message: &str,
    scope: &str,
    pattern: &str,
    search_mode: AnalysisSearchMode,
    values: &mut Vec<Value>,
    direct_body: bool,
) -> String {
    let operator = literal_operator(pattern, search_mode, values);
    let body = if matches!(scope, "attachments" | "document") {
        "false".into()
    } else if direct_body || search_mode != AnalysisSearchMode::Fuzzy {
        format!(
            "coalesce(sigint_inbox_item.body_noheader->>'body','') {operator}"
        )
    } else {
        format!("exists(select 1 from sigint_inbox_item literal_item where literal_item.id={message} and coalesce(literal_item.body_noheader->>'body','') {operator})")
    };
    let attachment = if scope == "body" {
        "false".into()
    } else {
        let media_filter = media_filter(message, scope);
        format!("exists(select 1 from signal_message_media media where {media_filter} and (coalesce(media.file_name,'') {operator} or exists(select 1 from attachment_chunk chunk join attachment_document doc on doc.media_id=chunk.media_id and doc.revision=chunk.revision where chunk.media_id=media.id and (chunk.text {operator} or chunk.member {operator} or chunk.summary {operator}))))")
    };
    format!("({body} or {attachment})")
}

fn exists_term(
    message: &str,
    scope: &str,
    chunk: &str,
    filename: &str,
    body: &str,
    correlated: bool,
) -> String {
    let mut sources = Vec::new();
    if !matches!(scope, "attachments" | "document") {
        sources.push(format!(
            "select body_search.id from sigint_search body_search where {}{body}",
            if correlated { format!("body_search.id={message} and ") } else { String::new() }
        ));
    }
    if scope != "body" {
        let key = if scope == "document" {
            "media.id"
        } else {
            "media.signal_message_id"
        };
        sources.push(format!(
            "select {key} from signal_message_media media where {}{filename}",
            if correlated {
                format!("{key}={message} and ")
            } else {
                String::new()
            }
        ));
        sources.push(format!("select {key} from attachment_chunk chunk join attachment_document doc on doc.media_id=chunk.media_id and doc.revision=chunk.revision join signal_message_media media on media.id=chunk.media_id where {}{chunk}", if correlated { format!("{key}={message} and ") } else { String::new() }));
    }
    if correlated {
        format!(
            "({})",
            sources
                .into_iter()
                .map(|source| format!("exists({source})"))
                .collect::<Vec<_>>()
                .join(" or ")
        )
    } else {
        format!("{message} in ({})", sources.join(" union "))
    }
}

pub fn message_filter(query: &str, scope: &str) -> anyhow::Result<SimpleExpr> {
    message_filter_with_mode(query, scope, None, false).c(h!())
}

pub(crate) fn message_filter_with_mode(
    query: &str,
    scope: &str,
    search_mode: Option<AnalysisSearchMode>,
    correlated: bool,
) -> anyhow::Result<SimpleExpr> {
    let mut values = Vec::new();
    let sql = text_predicate_with_correlation(
        query,
        "signal_message.id",
        scope,
        true,
        &mut values,
        correlated,
        search_mode,
        false,
    )
    .c(h!())?;
    Ok(Expr::cust_with_values(sql, values))
}

pub(crate) fn analysis_message_filter(
    query: &str,
    search_mode: Option<AnalysisSearchMode>,
    correlated: bool,
) -> anyhow::Result<SimpleExpr> {
    let mut values = Vec::new();
    let sql = text_predicate_with_correlation(
        query,
        "signal_message.id",
        "all",
        true,
        &mut values,
        correlated,
        search_mode,
        true,
    )
    .c(h!())?;
    Ok(Expr::cust_with_values(sql, values))
}

#[cfg(test)]
pub(crate) fn correlated_message_filter(
    query: &str,
) -> anyhow::Result<SimpleExpr> {
    message_filter_with_mode(query, "all", None, true).c(h!())
}

fn media_filter(message: &str, scope: &str) -> String {
    if scope == "document" {
        format!("media.id={message}")
    } else {
        format!("media.signal_message_id={message}")
    }
}
