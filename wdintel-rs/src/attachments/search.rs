use crate::rer_importer::analysis::AnalyticsMessageIdScope;
use crate::rer_importer::types::AnalysisSearchMode;
use crate::{h, types::ShortContext};
use sea_orm::{
    sea_query::{Expr, SimpleExpr},
    Value,
};

#[derive(Clone, Copy, Default)]
struct SearchSourceScope<'a> {
    relation: Option<&'a str>,
    message_ids: Option<&'a AnalyticsMessageIdScope>,
}

impl SearchSourceScope<'_> {
    fn id_filter(self, column: &str) -> String {
        match self.message_ids {
            Some(AnalyticsMessageIdScope::Empty) => "false and ".into(),
            Some(AnalyticsMessageIdScope::From(min_id)) => {
                format!("{column}>={min_id} and ")
            }
            Some(AnalyticsMessageIdScope::Inclusive { min_id, max_id }) => {
                format!("{column} between {min_id} and {max_id} and ")
            }
            None => String::new(),
        }
    }
}

fn bind(values: &mut Vec<Value>, value: impl Into<Value>) -> String {
    values.push(value.into());
    format!("${}", values.len())
}

fn term_tsquery(
    token: &str,
    prefixes: bool,
    values: &mut Vec<Value>,
    parse_once: bool,
) -> String {
    let parameter = bind(values, token);
    let query = if prefixes {
        format!("(plainto_tsquery('russian',{parameter}) || to_tsquery('russian', quote_literal({parameter}) || ':*'))")
    } else {
        format!("plainto_tsquery('russian',{parameter})")
    };
    if parse_once {
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
    terms_predicate(query, search_mode, values, CHUNK_TERMS)
}

/// Any-term superset over `chunk` and `media.file_name`, including negated terms.
pub(crate) fn attachment_terms_predicate_with_mode(
    query: &str,
    search_mode: Option<AnalysisSearchMode>,
    values: &mut Vec<Value>,
) -> anyhow::Result<String> {
    terms_predicate(query, search_mode, values, ATTACHMENT_TERMS)
}

/// Any-term superset over `audio_search.file_name`, including negated terms.
pub(crate) fn audio_terms_predicate_with_mode(
    query: &str,
    search_mode: Option<AnalysisSearchMode>,
    values: &mut Vec<Value>,
) -> anyhow::Result<String> {
    terms_predicate(query, search_mode, values, AUDIO_TERMS)
}

#[derive(Clone, Copy)]
struct TermColumns {
    chunk: bool,
    file_name: Option<&'static str>,
}

const CHUNK_TERMS: TermColumns = TermColumns {
    chunk: true,
    file_name: None,
};
const ATTACHMENT_TERMS: TermColumns = TermColumns {
    chunk: true,
    file_name: Some("media.file_name"),
};
const AUDIO_TERMS: TermColumns = TermColumns {
    chunk: false,
    file_name: Some("audio_search.file_name"),
};

fn terms_predicate(
    query: &str,
    search_mode: Option<AnalysisSearchMode>,
    values: &mut Vec<Value>,
    columns: TermColumns,
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
                predicates.extend(fuzzy_term_predicates(
                    token, prefixes, values, columns,
                ));
            } else {
                predicates.push(attachment_literal_predicate(
                    &literal_pattern(token),
                    search_mode,
                    values,
                    columns,
                ));
            }
        }
    }
    for pattern in parts.ilike.into_iter().chain(parts.not_ilike) {
        predicates.push(attachment_literal_predicate(
            &pattern,
            search_mode,
            values,
            columns,
        ));
    }
    Ok(if predicates.is_empty() {
        "false".into()
    } else {
        predicates.join(" or ")
    })
}

fn fuzzy_term_predicates(
    token: &str,
    prefixes: bool,
    values: &mut Vec<Value>,
    columns: TermColumns,
) -> Vec<String> {
    let mut predicates = Vec::new();
    if columns.chunk {
        let tsquery = term_tsquery(token, prefixes, values, false);
        predicates.push(format!("chunk.search_tsv @@ {tsquery}"));
    }
    if let Some(file_name) = columns.file_name {
        let pattern = bind(values, literal_pattern(token));
        predicates.push(format!(
            "coalesce({file_name},'') ilike {pattern} escape '\\'"
        ));
    }
    predicates
}

pub fn text_predicate(
    query: &str,
    message: &str,
    scope: &str,
    structured: bool,
    values: &mut Vec<Value>,
) -> anyhow::Result<String> {
    text_predicate_with_correlation(
        query,
        message,
        scope,
        structured,
        values,
        false,
        None,
        None,
        false,
        SearchSourceScope::default(),
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
    direct_body_key: Option<&str>,
    inline_tsquery: bool,
    source_scope: SearchSourceScope<'_>,
) -> anyhow::Result<String> {
    let mut predicates = search_predicates(
        query,
        message,
        scope,
        structured,
        values,
        correlated,
        search_mode,
        direct_body_key,
        inline_tsquery,
        source_scope,
    )
    .c(h!())?;
    predicates.matches.extend(predicates.exclusions);
    Ok(if predicates.matches.is_empty() {
        "true".into()
    } else {
        predicates.matches.join(" and ")
    })
}

struct SearchPredicates {
    matches: Vec<String>,
    exclusions: Vec<String>,
}

#[allow(clippy::too_many_arguments)]
fn search_predicates(
    query: &str,
    message: &str,
    scope: &str,
    structured: bool,
    values: &mut Vec<Value>,
    correlated: bool,
    search_mode: Option<AnalysisSearchMode>,
    direct_body_key: Option<&str>,
    inline_tsquery: bool,
    source_scope: SearchSourceScope<'_>,
) -> anyhow::Result<SearchPredicates> {
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
    let combined = if search_mode == AnalysisSearchMode::Fuzzy && !correlated {
        combined_or_predicate(
            &text_query,
            message,
            scope,
            prefixes,
            values,
            source_scope,
        )
    } else {
        None
    };
    let mut alternatives: Vec<Vec<String>> = vec![vec![]];
    for token in text_query.split_whitespace().filter(|_| combined.is_none()) {
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
            let tsquery = term_tsquery(
                token,
                prefixes,
                values,
                correlated && !inline_tsquery,
            );
            let name_pattern = bind(values, literal_pattern(token));
            exists_term(
                message,
                scope,
                &format!("chunk.search_tsv @@ {tsquery}"),
                &format!("media.file_name ilike {name_pattern} escape '\\'"),
                &format!("body_search.search_tsv @@ {tsquery}"),
                correlated,
                source_scope,
            )
        } else {
            message_literal_predicate(
                message,
                scope,
                &literal_pattern(token),
                search_mode,
                values,
                direct_body_key,
                correlated,
                source_scope,
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
    let mut exclusions = vec![];
    if let Some(combined) = combined {
        filters.push(combined);
    } else if !alternatives.is_empty() {
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
            direct_body_key,
            correlated,
            source_scope,
        );
        if negative {
            exclusions.push(format!("not ({predicate})"));
        } else {
            filters.push(format!("({predicate})"));
        }
    }
    Ok(SearchPredicates {
        matches: filters,
        exclusions,
    })
}

fn combined_or_predicate(
    query: &str,
    message: &str,
    scope: &str,
    prefixes: bool,
    values: &mut Vec<Value>,
    source_scope: SearchSourceScope<'_>,
) -> Option<String> {
    let mut terms = Vec::new();
    let mut expect_term = true;
    for token in query.split_whitespace() {
        if expect_term {
            if token.starts_with('-')
                || token.eq_ignore_ascii_case("or")
                || token.eq_ignore_ascii_case("and")
            {
                return None;
            }
            terms.push(token);
        } else if !token.eq_ignore_ascii_case("or") {
            return None;
        }
        expect_term = !expect_term;
    }
    if expect_term || terms.len() < 2 {
        return None;
    }
    let tsqueries = terms
        .iter()
        .map(|term| {
            term_tsquery(
                term,
                prefixes,
                values,
                source_scope.relation.is_some(),
            )
        })
        .collect::<Vec<_>>();
    let filenames = terms
        .iter()
        .map(|term| {
            let parameter = bind(values, literal_pattern(term));
            format!("media.file_name ilike {parameter} escape '\\'")
        })
        .collect::<Vec<_>>();
    let tsquery = format!("({})", tsqueries.join(" || "));
    Some(exists_term(
        message,
        scope,
        &format!("chunk.search_tsv @@ {tsquery}"),
        &format!("({})", filenames.join(" or ")),
        &format!("body_search.search_tsv @@ {tsquery}"),
        false,
        source_scope,
    ))
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

fn attachment_literal_predicate(
    pattern: &str,
    search_mode: AnalysisSearchMode,
    values: &mut Vec<Value>,
    columns: TermColumns,
) -> String {
    let operator = literal_operator(pattern, search_mode, values);
    let mut predicates = Vec::new();
    if columns.chunk {
        predicates.push(format!("chunk.text {operator} or chunk.member {operator} or chunk.summary {operator}"));
    }
    if let Some(file_name) = columns.file_name {
        predicates.push(format!("coalesce({file_name},'') {operator}"));
    }
    format!("({})", predicates.join(" or "))
}

fn message_literal_predicate(
    message: &str,
    scope: &str,
    pattern: &str,
    search_mode: AnalysisSearchMode,
    values: &mut Vec<Value>,
    direct_body_key: Option<&str>,
    correlated: bool,
    source_scope: SearchSourceScope<'_>,
) -> String {
    let operator = literal_operator(pattern, search_mode, values);
    let mut sources = Vec::new();
    let body = if !matches!(scope, "attachments" | "document")
        && direct_body_key.is_some()
    {
        Some(format!(
            "coalesce(sigint_inbox_item.body_noheader->>'body','') {operator}"
        ))
    } else {
        if !matches!(scope, "attachments" | "document") {
            sources.push(format!("select literal_item.id from sigint_inbox_item literal_item where {}coalesce(literal_item.body_noheader->>'body','') {operator}", if correlated { format!("literal_item.id={message} and ") } else { source_scope.id_filter("literal_item.id") }));
        }
        None
    };
    let filename = if pattern.chars().all(|ch| ch == '%') {
        format!("coalesce(media.file_name,'') {operator}")
    } else {
        format!("media.file_name {operator}")
    };
    sources.extend(attachment_term_sources(
        message,
        scope,
        &format!("(chunk.text {operator} or chunk.member {operator} or chunk.summary {operator})"),
        &filename,
        &format!("audio_search.file_name {operator}"),
        correlated,
        source_scope,
    ));
    if let Some(body) = &body {
        if let Some(key) =
            direct_body_key.filter(|_| !correlated && !sources.is_empty())
        {
            return format!(
                "({body} or {key}=any(array({})))",
                sources.join(" union ")
            );
        }
    }
    let matches = term_sources_predicate(message, sources, correlated, false);
    match body {
        Some(body) => format!("({body} or {matches})"),
        None => matches,
    }
}

fn exists_term(
    message: &str,
    scope: &str,
    chunk: &str,
    filename: &str,
    body: &str,
    correlated: bool,
    source_scope: SearchSourceScope<'_>,
) -> String {
    let mut sources = Vec::new();
    if !matches!(scope, "attachments" | "document") {
        sources.push(match source_scope.relation {
            Some(source_scope) => format!("select body_search.id from {source_scope} source_candidate join lateral (select body_search.id from sigint_search body_search where body_search.id=source_candidate.id and {body} offset 0) body_search on true"),
            None => format!("select body_search.id from sigint_search body_search where {}{body}", if correlated { format!("body_search.id={message} and ") } else { source_scope.id_filter("body_search.id") }),
        });
    }
    sources.extend(attachment_term_sources(
        message,
        scope,
        chunk,
        filename,
        &filename.replace("media.file_name", "audio_search.file_name"),
        correlated,
        source_scope,
    ));
    term_sources_predicate(
        message,
        sources,
        correlated,
        source_scope.message_ids.is_some(),
    )
}

fn attachment_term_sources(
    message: &str,
    scope: &str,
    chunk: &str,
    filename: &str,
    audio: &str,
    correlated: bool,
    source_scope: SearchSourceScope<'_>,
) -> Vec<String> {
    let mut sources = Vec::new();
    if scope != "body" {
        let key = if scope == "document" {
            "media.id"
        } else {
            "media.signal_message_id"
        };
        let correlation = if correlated {
            format!("{} and ", media_filter(message, scope))
        } else {
            source_scope.relation.map(|scope| format!("media.signal_message_id in (select id from {scope}) and ")).unwrap_or_else(|| source_scope.id_filter("media.signal_message_id"))
        };
        sources.push(format!("select {key} from signal_message_media media where {correlation}{filename}"));
        sources.push(format!("select {key} from attachment_chunk chunk join attachment_document doc on doc.media_id=chunk.media_id and doc.revision=chunk.revision join signal_message_media media on media.id=chunk.media_id where {correlation}{chunk}"));
    }
    if scope != "body" && scope != "document" {
        let correlation = if correlated {
            format!("audio_search.signal_message_id={message} and ")
        } else {
            source_scope.relation.map(|scope| format!("audio_search.signal_message_id in (select id from {scope}) and ")).unwrap_or_else(|| source_scope.id_filter("audio_search.signal_message_id"))
        };
        sources.push(format!("select audio_search.signal_message_id from signal_message_audio_search audio_search where {correlation}{audio}"));
    }
    sources
}

fn term_sources_predicate(
    message: &str,
    sources: Vec<String>,
    correlated: bool,
    materialize_ids: bool,
) -> String {
    if sources.is_empty() {
        "false".into()
    } else if correlated {
        format!(
            "({})",
            sources
                .into_iter()
                .map(|source| format!("exists({source})"))
                .collect::<Vec<_>>()
                .join(" or ")
        )
    } else if materialize_ids {
        // A scalar subplan keeps the ID filter inside pg_clickhouse (#3571).
        format!("{message}=any(array({}))", sources.join(" union "))
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
        None,
        false,
        SearchSourceScope::default(),
    )
    .c(h!())?;
    Ok(Expr::cust_with_values(sql, values))
}

pub(crate) fn analysis_message_filter(
    query: &str,
    search_mode: Option<AnalysisSearchMode>,
    correlated: bool,
    message_ids: Option<&AnalyticsMessageIdScope>,
    inbox_required: bool,
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
        Some(if inbox_required {
            "sigint_inbox_item.id"
        } else {
            "signal_message.id"
        }),
        message_ids.is_some(),
        SearchSourceScope {
            relation: None,
            message_ids,
        },
    )
    .c(h!())?;
    Ok(Expr::cust_with_values(sql, values))
}

pub(crate) fn use_source_search_scope(
    query: &str,
    search_mode: Option<AnalysisSearchMode>,
    scope: &super::analytics::SearchCoverageScope<'_>,
) -> anyhow::Result<bool> {
    let (Some(since), Some(till)) = (scope.since, scope.till) else {
        return Ok(false);
    };
    if search_mode.unwrap_or_default() != AnalysisSearchMode::Fuzzy
        || till - since
            > chrono::Duration::days(
                crate::config::ANALYSIS_SOURCE_SEARCH_SCOPE_MAX_DAYS,
            )
    {
        return Ok(false);
    }
    let parts =
        crate::rer_importer::analysis::search::parse_search_parts(query)
            .c(h!())?;
    Ok(!parts.not_ilike.is_empty()
        && parts
            .ts_query
            .split_whitespace()
            .any(|word| word.eq_ignore_ascii_case("or")))
}

pub(crate) fn scoped_analysis_message_filter(
    query: &str,
    search_mode: Option<AnalysisSearchMode>,
    scope: &super::analytics::SearchCoverageScope<'_>,
) -> anyhow::Result<SimpleExpr> {
    let mut values = Vec::new();
    let scope_sql = source_search_scope(scope, &mut values);
    let predicates = search_predicates(
        query,
        "signal_message.id",
        "all",
        true,
        &mut values,
        false,
        search_mode,
        Some("signal_message.id"),
        false,
        SearchSourceScope {
            relation: Some("source_search_scope"),
            message_ids: None,
        },
    )
    .c(h!())?;
    let matches = if predicates.matches.is_empty() {
        "true".into()
    } else {
        predicates.matches.join(" and ")
    };
    let exclusions = if predicates.exclusions.is_empty() {
        "true".into()
    } else {
        predicates.exclusions.join(" and ")
    };
    Ok(Expr::cust_with_values(
        format!("{} signal_message.id in (with source_search_scope as materialized ({scope_sql}), source_search_matches as materialized (select signal_message.id from source_search_scope signal_message left join sigint_inbox_item on sigint_inbox_item.id=signal_message.id where {matches}) select signal_message.id from source_search_matches signal_message left join sigint_inbox_item on sigint_inbox_item.id=signal_message.id where {exclusions})", crate::config::ANALYSIS_SOURCE_SEARCH_SQL_HINT),
        values,
    ))
}

fn source_search_scope(
    scope: &super::analytics::SearchCoverageScope<'_>,
    values: &mut Vec<Value>,
) -> String {
    use super::analytics::SearchTimeBasis;
    let groups = bind(values, scope.groups.to_vec());
    let column = match scope.time_basis {
        SearchTimeBasis::Interception => "candidate_inbox.datetime",
        SearchTimeBasis::Timestamp => "candidate_message.timestamp",
        SearchTimeBasis::Creation => "candidate_message.created_at",
    };
    let mut filters = vec![format!("exists(select 1 from signal_message_group candidate_access where candidate_access.signal_message_id=candidate_message.id and candidate_access.group_master_key=any({groups}) offset 0)")];
    if let Some(since) = scope.since {
        let parameter = bind(values, since);
        filters.push(format!("{column}>={parameter}"));
    }
    if let Some(till) = scope.till {
        let parameter = bind(values, till);
        filters.push(format!(
            "{column}{}{parameter}",
            if scope.till_inclusive { "<=" } else { "<" }
        ));
    }
    let from = match scope.time_basis {
        SearchTimeBasis::Interception => "sigint_inbox_item candidate_inbox join lateral (select candidate_message.id from signal_message candidate_message where candidate_message.id=candidate_inbox.id and not candidate_message.deleted offset 0) candidate_message on true",
        _ => "signal_message candidate_message",
    };
    if !matches!(scope.time_basis, SearchTimeBasis::Interception) {
        filters.push("not candidate_message.deleted".into());
    }
    format!(
        "select candidate_message.id from {from} where {}",
        filters.join(" and ")
    )
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
