use super::types::{
    AnalysisResult, FileAnalysisInput, RuleExpression, RuleField, RuleMatcher,
    RuleValidationError, TagRuleDefinition,
};
use regex::{Regex, RegexBuilder};
use std::collections::BTreeSet;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const MAX_RULE_DEPTH: usize = 16;
const MAX_RULE_NODES: usize = 256;
const MAX_VALUES_PER_MATCH: usize = 64;
const MAX_LITERAL_CHARS: usize = 1_024;
const MAX_REGEX_CHARS: usize = 512;

pub(in crate::devices) struct CompiledTagRules {
    rules: Vec<CompiledTagRule>,
}

struct CompiledTagRule {
    tag_id: Uuid,
    expression: CompiledExpression,
}

enum CompiledExpression {
    All(Vec<CompiledExpression>),
    Any(Vec<CompiledExpression>),
    Not(Box<CompiledExpression>),
    Match(CompiledMatch),
}

struct CompiledMatch {
    field: RuleField,
    matcher: CompiledMatcher,
}

enum CompiledMatcher {
    Shared(Vec<Regex>),
    ContainsToken {
        regular: Vec<Regex>,
        path: Vec<Regex>,
    },
}

struct NormalizedFileMetadata {
    file_name: String,
    directory_path: String,
    full_path: String,
    extension: String,
}

impl NormalizedFileMetadata {
    fn from_input(input: &FileAnalysisInput) -> Self {
        let name = normalize_nfc(&input.name);
        let full_path = normalize_path(&input.absolute_path);
        let file_name = remove_last_suffix(&name).to_string();
        let directory_path = parent_path(&full_path).to_string();
        let extension = input
            .extension
            .as_deref()
            .map(normalize_nfc)
            .map(|value| value.trim_start_matches('.').to_string())
            .unwrap_or_else(|| {
                last_suffix(&name).unwrap_or_default().to_string()
            });

        Self {
            file_name,
            directory_path,
            full_path,
            extension,
        }
    }

    fn field(&self, field: RuleField) -> &str {
        match field {
            RuleField::FileName => &self.file_name,
            RuleField::DirectoryPath => &self.directory_path,
            RuleField::FullPath => &self.full_path,
            RuleField::Extension => &self.extension,
        }
    }
}

pub(in crate::devices) fn deserialize_rule_expression(
    value: serde_json::Value,
) -> Result<RuleExpression, RuleValidationError> {
    serde_json::from_value(value).map_err(|_| {
        validation_error(
            "rule_expression",
            "invalid_expression",
            "Правило має некоректний формат",
        )
    })
}

pub(in crate::devices) fn compile_tag_rules(
    mut definitions: Vec<TagRuleDefinition>,
) -> Result<CompiledTagRules, RuleValidationError> {
    definitions.sort_by_key(|definition| definition.tag_id);
    let mut rules = Vec::with_capacity(definitions.len());
    for definition in definitions {
        let mut state = CompilerState { nodes: 0 };
        let expression = compile_expression(
            definition.rule_expression,
            "rule_expression",
            1,
            &mut state,
        )?;
        rules.push(CompiledTagRule {
            tag_id: definition.tag_id,
            expression,
        });
    }
    Ok(CompiledTagRules { rules })
}

pub(in crate::devices) fn analyze(
    rules: &CompiledTagRules,
    input: &FileAnalysisInput,
) -> AnalysisResult {
    let metadata = NormalizedFileMetadata::from_input(input);
    let mut matched_tags = rules
        .rules
        .iter()
        .filter(|rule| evaluate(&rule.expression, &metadata))
        .map(|rule| rule.tag_id)
        .collect::<Vec<_>>();
    matched_tags.sort_unstable();
    matched_tags.dedup();
    AnalysisResult { matched_tags }
}

#[cfg(test)]
pub(in crate::devices) fn test_rule_expression(
    expression: RuleExpression,
    input: &FileAnalysisInput,
) -> Result<bool, RuleValidationError> {
    let tag_id = Uuid::nil();
    let rules = compile_tag_rules(vec![TagRuleDefinition {
        tag_id,
        rule_expression: expression,
    }])?;
    Ok(analyze(&rules, input).matched_tags == [tag_id])
}

fn compile_expression(
    expression: RuleExpression,
    path: &str,
    depth: usize,
    state: &mut CompilerState,
) -> Result<CompiledExpression, RuleValidationError> {
    if depth > MAX_RULE_DEPTH {
        return Err(validation_error(
            path,
            "max_depth_exceeded",
            "Правило має надто велику глибину",
        ));
    }
    state.nodes += 1;
    if state.nodes > MAX_RULE_NODES {
        return Err(validation_error(
            path,
            "max_nodes_exceeded",
            "Правило містить надто багато умов",
        ));
    }

    match expression {
        RuleExpression::RuleAll { children } => Ok(CompiledExpression::All(
            compile_children(children, path, depth, state)?,
        )),
        RuleExpression::RuleAny { children } => Ok(CompiledExpression::Any(
            compile_children(children, path, depth, state)?,
        )),
        RuleExpression::Not { child } => {
            Ok(CompiledExpression::Not(Box::new(compile_expression(
                *child,
                &format!("{path}.child"),
                depth + 1,
                state,
            )?)))
        }
        RuleExpression::Match {
            field,
            matcher,
            values,
        } => compile_match(field, matcher, values, path),
    }
}

fn compile_children(
    children: Vec<RuleExpression>,
    path: &str,
    depth: usize,
    state: &mut CompilerState,
) -> Result<Vec<CompiledExpression>, RuleValidationError> {
    if children.is_empty() {
        return Err(validation_error(
            &format!("{path}.children"),
            "empty_group",
            "Група правила повинна містити хоча б одну умову",
        ));
    }
    children
        .into_iter()
        .enumerate()
        .map(|(index, child)| {
            compile_expression(
                child,
                &format!("{path}.children[{index}]"),
                depth + 1,
                state,
            )
        })
        .collect()
}

fn compile_match(
    field: RuleField,
    matcher: RuleMatcher,
    values: Vec<String>,
    path: &str,
) -> Result<CompiledExpression, RuleValidationError> {
    let values = normalize_values(values, matcher, path)?;
    let matcher = match matcher {
        RuleMatcher::ContainsToken => CompiledMatcher::ContainsToken {
            regular: compile_literal_patterns(
                &values,
                LiteralPattern::ContainsToken { path: false },
                path,
            )?,
            path: compile_literal_patterns(
                &values,
                LiteralPattern::ContainsToken { path: true },
                path,
            )?,
        },
        RuleMatcher::Regex => {
            CompiledMatcher::Shared(compile_raw_regexes(&values, path)?)
        }
        RuleMatcher::Equals => CompiledMatcher::Shared(
            compile_literal_patterns(&values, LiteralPattern::Equals, path)?,
        ),
        RuleMatcher::Contains => CompiledMatcher::Shared(
            compile_literal_patterns(&values, LiteralPattern::Contains, path)?,
        ),
    };
    Ok(CompiledExpression::Match(CompiledMatch { field, matcher }))
}

fn normalize_values(
    values: Vec<String>,
    matcher: RuleMatcher,
    path: &str,
) -> Result<Vec<String>, RuleValidationError> {
    if values.is_empty() {
        return Err(validation_error(
            &format!("{path}.values"),
            "empty_values",
            "Умова повинна містити хоча б одне значення",
        ));
    }
    if values.len() > MAX_VALUES_PER_MATCH {
        return Err(validation_error(
            &format!("{path}.values"),
            "max_values_exceeded",
            "Умова містить надто багато значень",
        ));
    }

    let mut normalized = Vec::with_capacity(values.len());
    let mut seen = BTreeSet::new();
    for (index, value) in values.into_iter().enumerate() {
        let value = normalize_nfc(&value);
        let value_path = format!("{path}.values[{index}]");
        if value.trim().is_empty() {
            return Err(validation_error(
                &value_path,
                "empty_literal",
                "Значення не може бути порожнім",
            ));
        }
        let max_chars = if matcher == RuleMatcher::Regex {
            MAX_REGEX_CHARS
        } else {
            MAX_LITERAL_CHARS
        };
        if value.chars().count() > max_chars {
            return Err(validation_error(
                &value_path,
                if matcher == RuleMatcher::Regex {
                    "regex_too_long"
                } else {
                    "literal_too_long"
                },
                "Значення перевищує дозволену довжину",
            ));
        }
        if !seen.insert(value.to_lowercase()) {
            return Err(validation_error(
                &value_path,
                "duplicate_value",
                "Значення не можна вказувати повторно",
            ));
        }
        normalized.push(value);
    }
    Ok(normalized)
}

fn compile_raw_regexes(
    values: &[String],
    path: &str,
) -> Result<Vec<Regex>, RuleValidationError> {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let value_path = format!("{path}.values[{index}]");
            if changes_inline_case_mode(value) {
                return Err(validation_error(
                    &value_path,
                    "inline_case_mode",
                    "Регулярний вираз не може змінювати режим регістру",
                ));
            }
            build_case_insensitive_regex(value).map_err(|_| {
                validation_error(
                    &value_path,
                    "invalid_regex",
                    "Некоректний регулярний вираз",
                )
            })
        })
        .collect()
}

fn compile_literal_patterns(
    values: &[String],
    pattern: LiteralPattern,
    path: &str,
) -> Result<Vec<Regex>, RuleValidationError> {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let escaped = regex::escape(value);
            let pattern = match pattern {
                LiteralPattern::Equals => format!("^(?:{escaped})$"),
                LiteralPattern::Contains => escaped,
                LiteralPattern::ContainsToken { path: false } => {
                    format!(r"(?:^|[\s_-])(?:{escaped})(?:$|[\s_-])")
                }
                LiteralPattern::ContainsToken { path: true } => {
                    format!(r"(?:^|[\s_/-])(?:{escaped})(?:$|[\s_/-])")
                }
            };
            build_case_insensitive_regex(&pattern).map_err(|_| {
                validation_error(
                    &format!("{path}.values[{index}]"),
                    "invalid_literal",
                    "Значення не вдалося скомпілювати",
                )
            })
        })
        .collect()
}

fn build_case_insensitive_regex(pattern: &str) -> Result<Regex, regex::Error> {
    RegexBuilder::new(pattern)
        .case_insensitive(true)
        .unicode(true)
        .build()
}

fn changes_inline_case_mode(pattern: &str) -> bool {
    let bytes = pattern.as_bytes();
    let mut index = 0;
    while index + 2 < bytes.len() {
        if bytes[index] == b'(' && bytes[index + 1] == b'?' {
            let mut flag_index = index + 2;
            let mut is_flag_group = false;
            let mut mentions_case = false;
            while flag_index < bytes.len() {
                match bytes[flag_index] {
                    b'i' => {
                        is_flag_group = true;
                        mentions_case = true;
                    }
                    b'm' | b's' | b'x' | b'U' | b'-' => {
                        is_flag_group = true;
                    }
                    b':' | b')' => {
                        if is_flag_group && mentions_case {
                            return true;
                        }
                        break;
                    }
                    _ => break,
                }
                flag_index += 1;
            }
        }
        index += 1;
    }
    false
}

fn evaluate(
    expression: &CompiledExpression,
    metadata: &NormalizedFileMetadata,
) -> bool {
    match expression {
        CompiledExpression::All(children) => {
            children.iter().all(|child| evaluate(child, metadata))
        }
        CompiledExpression::Any(children) => {
            children.iter().any(|child| evaluate(child, metadata))
        }
        CompiledExpression::Not(child) => !evaluate(child, metadata),
        CompiledExpression::Match(condition) => {
            let value = metadata.field(condition.field);
            match &condition.matcher {
                CompiledMatcher::Shared(regexes) => {
                    regexes.iter().any(|regex| regex.is_match(value))
                }
                CompiledMatcher::ContainsToken { regular, path } => {
                    let regexes = if condition.field.is_path() {
                        path
                    } else {
                        regular
                    };
                    regexes.iter().any(|regex| regex.is_match(value))
                }
            }
        }
    }
}

fn normalize_nfc(value: &str) -> String {
    value.nfc().collect()
}

fn normalize_path(value: &str) -> String {
    let value = normalize_nfc(value);
    let mut normalized = String::with_capacity(value.len());
    let mut previous_separator = false;
    for character in value.chars() {
        let is_separator = matches!(character, '/' | '\\');
        if is_separator {
            if !previous_separator {
                normalized.push('/');
            }
        } else {
            normalized.push(character);
        }
        previous_separator = is_separator;
    }
    normalized
}

fn remove_last_suffix(name: &str) -> &str {
    match suffix_separator(name) {
        Some(index) => &name[..index],
        None => name,
    }
}

fn last_suffix(name: &str) -> Option<&str> {
    suffix_separator(name).map(|index| &name[index + 1..])
}

fn suffix_separator(name: &str) -> Option<usize> {
    name.rfind('.').filter(|index| *index > 0)
}

fn parent_path(path: &str) -> &str {
    let path_without_trailing_separator = if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    };
    match path_without_trailing_separator.rfind('/') {
        Some(0) => "/",
        Some(index) => &path_without_trailing_separator[..index],
        None => "",
    }
}

fn validation_error(
    path: &str,
    code: &str,
    message: &str,
) -> RuleValidationError {
    RuleValidationError {
        path: path.to_string(),
        code: code.to_string(),
        message: message.to_string(),
    }
}

struct CompilerState {
    nodes: usize,
}

#[derive(Clone, Copy)]
enum LiteralPattern {
    Equals,
    Contains,
    ContainsToken { path: bool },
}
