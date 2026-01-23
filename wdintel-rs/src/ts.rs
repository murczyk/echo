use crate::types::*;

#[derive(Debug, Clone)]
enum TypeDef {
    Alias {
        name: String,
        expr: TypeExpr,
    },
    Union {
        name: String,
        variants: Vec<Variant>,
    },
}

#[derive(Debug, Clone)]
struct Variant {
    name: String,
    args: Vec<TypeExpr>,
}

#[derive(Debug, Clone)]
enum TypeExpr {
    Var(String),
    App { name: String, args: Vec<TypeExpr> },
    Tuple(Vec<TypeExpr>),
    Record(Vec<(String, TypeExpr)>),
}

#[derive(Debug, Clone)]
enum Token {
    Ident(String),
    LParen,
    RParen,
    LBrace,
    RBrace,
    Comma,
    Colon,
}

struct TokenStream {
    tokens: Vec<Token>,
    pos: usize,
}

impl TokenStream {
    fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, pos: 0 }
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn next(&mut self) -> Option<Token> {
        let token = self.tokens.get(self.pos).cloned();
        if token.is_some() {
            self.pos += 1;
        }
        token
    }

    fn expect_ident(&mut self) -> anyhow::Result<String> {
        match self.next() {
            Some(Token::Ident(name)) => Ok(name),
            _ => bail!("expected identifier"),
        }
    }

    fn expect_token(&mut self, expected: Token) -> anyhow::Result<()> {
        let token = self.next().context("expected token")?;
        if std::mem::discriminant(&token) == std::mem::discriminant(&expected) {
            Ok(())
        } else {
            bail!("unexpected token")
        }
    }

    fn is_empty(&self) -> bool {
        self.pos >= self.tokens.len()
    }
}

pub fn main_gen_ts() -> Result<(), AppError> {
    let bindings = read_bindings_elm()?;
    let defs = parse_bindings(&bindings)?;
    let output = render_typescript(&defs);
    write_bindings_ts(&output)?;
    Ok(())
}

fn read_bindings_elm() -> Result<String, AppError> {
    Ok(std::fs::read_to_string("../wdintel-web/src/Bindings.elm").c(h!())?)
}

fn write_bindings_ts(contents: &str) -> Result<(), AppError> {
    Ok(std::fs::write("../wdintel-web/src/Bindings.ts", contents).c(h!())?)
}

fn parse_bindings(contents: &str) -> anyhow::Result<Vec<TypeDef>> {
    let lines: Vec<&str> = contents.lines().collect();
    let mut index = 0;
    let mut defs = Vec::new();

    while index < lines.len() {
        let line = lines[index].trim();
        if line.starts_with("type alias ") {
            let (def, next_index) = parse_type_alias(&lines, index)?;
            defs.push(def);
            index = next_index;
            continue;
        }

        if line.starts_with("type ") && !line.starts_with("type alias ") {
            let (def, next_index) = parse_union_type(&lines, index)?;
            defs.push(def);
            index = next_index;
            continue;
        }

        index += 1;
    }

    Ok(defs)
}

fn parse_type_alias(
    lines: &[&str],
    start: usize,
) -> anyhow::Result<(TypeDef, usize)> {
    let line = lines[start];
    let mut remainder = line.trim_start_matches("type alias ").trim();
    if let Some(rest) = remainder.strip_suffix('=') {
        remainder = rest.trim();
    }
    let name = remainder
        .split_whitespace()
        .next()
        .context("missing type alias name")?
        .to_string();

    let mut index = start + 1;
    index = skip_empty_lines(lines, index);

    if index >= lines.len() {
        bail!("unexpected end of file after type alias {name}");
    }

    let line = lines[index].trim();
    let (expr, next_index) = if line.starts_with('{') {
        parse_record_alias(lines, index)?
    } else {
        parse_simple_alias(lines, index)?
    };

    Ok((TypeDef::Alias { name, expr }, next_index))
}

fn parse_record_alias(
    lines: &[&str],
    start: usize,
) -> anyhow::Result<(TypeExpr, usize)> {
    let mut fields: Vec<(String, TypeExpr)> = Vec::new();
    let mut index = start;

    while index < lines.len() {
        let raw = lines[index].trim();
        if raw.starts_with('}') {
            return Ok((TypeExpr::Record(fields), index + 1));
        }

        let cleaned = strip_record_prefix(raw);
        if cleaned.is_empty() {
            index += 1;
            continue;
        }

        let (field, type_str) =
            cleaned.split_once(" : ").context("invalid record field")?;
        let expr = parse_type_expr_from_str(type_str)?;
        fields.push((field.to_string(), expr));
        index += 1;
    }

    bail!("unterminated record type")
}

fn parse_simple_alias(
    lines: &[&str],
    start: usize,
) -> anyhow::Result<(TypeExpr, usize)> {
    let mut index = start;
    let mut parts: Vec<String> = Vec::new();

    while index < lines.len() {
        let line = lines[index].trim();
        if line.is_empty() {
            break;
        }
        if line.starts_with("type ") {
            break;
        }
        parts.push(line.to_string());
        index += 1;
    }

    let expr_str = parts.join(" ");
    let expr = parse_type_expr_from_str(&expr_str)?;
    Ok((expr, index))
}

fn parse_union_type(
    lines: &[&str],
    start: usize,
) -> anyhow::Result<(TypeDef, usize)> {
    let name = lines[start].trim_start_matches("type ").trim().to_string();
    let mut index = start + 1;
    let mut variants = Vec::new();

    while index < lines.len() {
        let line = lines[index].trim();
        if !(line.starts_with('=') || line.starts_with('|')) {
            break;
        }

        let variant_line =
            line.trim_start_matches('=').trim_start_matches('|').trim();
        if variant_line.is_empty() {
            index += 1;
            continue;
        }

        let parts = split_top_level(variant_line);
        let mut parts_iter = parts.into_iter();
        let variant_name = parts_iter
            .next()
            .context("missing variant name")?
            .to_string();
        let args = parts_iter
            .map(|part| parse_type_expr_from_str(&part))
            .collect::<anyhow::Result<Vec<_>>>()?;
        variants.push(Variant {
            name: variant_name,
            args,
        });

        index += 1;
    }

    Ok((TypeDef::Union { name, variants }, index))
}

fn skip_empty_lines(lines: &[&str], mut index: usize) -> usize {
    while index < lines.len() && lines[index].trim().is_empty() {
        index += 1;
    }
    index
}

fn strip_record_prefix(line: &str) -> &str {
    let trimmed = line.trim();
    let trimmed = trimmed.strip_prefix('{').unwrap_or(trimmed).trim();
    trimmed.strip_prefix(',').unwrap_or(trimmed).trim()
}

fn split_top_level(value: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut paren_depth: usize = 0;
    let mut brace_depth: usize = 0;

    for ch in value.chars() {
        match ch {
            '(' => paren_depth += 1,
            ')' => paren_depth = paren_depth.saturating_sub(1),
            '{' => brace_depth += 1,
            '}' => brace_depth = brace_depth.saturating_sub(1),
            ' ' if paren_depth == 0 && brace_depth == 0 => {
                if !current.is_empty() {
                    parts.push(current.trim().to_string());
                    current.clear();
                }
                continue;
            }
            _ => {}
        }
        current.push(ch);
    }

    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }

    parts
}

fn parse_type_expr_from_str(value: &str) -> anyhow::Result<TypeExpr> {
    let tokens = tokenize(value);
    let mut stream = TokenStream::new(tokens);
    let expr = parse_type_expr(&mut stream)?;
    if !stream.is_empty() {
        bail!("unexpected tokens in type expression: {value}");
    }
    Ok(expr)
}

fn tokenize(value: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch.is_whitespace() {
            continue;
        }

        let token = match ch {
            '(' => Token::LParen,
            ')' => Token::RParen,
            '{' => Token::LBrace,
            '}' => Token::RBrace,
            ',' => Token::Comma,
            ':' => Token::Colon,
            _ => {
                if ch.is_alphanumeric() || ch == '_' {
                    let mut ident = String::new();
                    ident.push(ch);
                    while let Some(next) = chars.peek() {
                        if next.is_alphanumeric() || *next == '_' {
                            ident.push(*next);
                            chars.next();
                        } else {
                            break;
                        }
                    }
                    Token::Ident(ident)
                } else {
                    continue;
                }
            }
        };
        tokens.push(token);
    }

    tokens
}

fn parse_type_expr(stream: &mut TokenStream) -> anyhow::Result<TypeExpr> {
    let mut atoms = Vec::new();

    loop {
        match stream.peek() {
            Some(Token::Ident(_))
            | Some(Token::LParen)
            | Some(Token::LBrace) => {
                atoms.push(parse_atom(stream)?);
            }
            _ => break,
        }
    }

    if atoms.is_empty() {
        bail!("expected type expression")
    } else if atoms.len() == 1 {
        Ok(atoms.remove(0))
    } else {
        match atoms.remove(0) {
            TypeExpr::Var(name) => Ok(TypeExpr::App { name, args: atoms }),
            other => bail!("unexpected type application: {other:?}"),
        }
    }
}

fn parse_atom(stream: &mut TokenStream) -> anyhow::Result<TypeExpr> {
    match stream.peek() {
        Some(Token::Ident(_)) => Ok(TypeExpr::Var(stream.expect_ident()?)),
        Some(Token::LParen) => parse_paren_expr(stream),
        Some(Token::LBrace) => parse_record_expr(stream),
        _ => bail!("unexpected token in type expression"),
    }
}

fn parse_paren_expr(stream: &mut TokenStream) -> anyhow::Result<TypeExpr> {
    stream.expect_token(Token::LParen)?;
    let mut items = Vec::new();

    items.push(parse_type_expr(stream)?);

    while let Some(Token::Comma) = stream.peek() {
        stream.next();
        items.push(parse_type_expr(stream)?);
    }

    stream.expect_token(Token::RParen)?;

    if items.len() == 1 {
        Ok(items.remove(0))
    } else {
        Ok(TypeExpr::Tuple(items))
    }
}

fn parse_record_expr(stream: &mut TokenStream) -> anyhow::Result<TypeExpr> {
    stream.expect_token(Token::LBrace)?;
    let mut fields = Vec::new();

    while let Some(token) = stream.peek() {
        if matches!(token, Token::RBrace) {
            stream.next();
            return Ok(TypeExpr::Record(fields));
        }

        let name = stream.expect_ident()?;
        stream.expect_token(Token::Colon)?;
        let expr = parse_type_expr(stream)?;
        fields.push((name, expr));

        if matches!(stream.peek(), Some(Token::Comma)) {
            stream.next();
        }
    }

    bail!("unterminated record")
}

fn render_typescript(defs: &[TypeDef]) -> String {
    let mut output = String::new();
    output.push_str("// generated by wdintel-rs gen-ts\n");
    output.push_str("// do not edit manually\n\n");

    if defs.iter().any(def_uses_result) {
        output
            .push_str("export type Result<E, T> = { Ok: T } | { Err: E };\n\n");
    }

    for def in defs {
        output.push_str(&render_def(def));
        output.push_str("\n\n");
    }

    output
}

fn def_uses_result(def: &TypeDef) -> bool {
    match def {
        TypeDef::Alias { expr, .. } => type_uses_result(expr),
        TypeDef::Union { variants, .. } => variants
            .iter()
            .any(|variant| variant.args.iter().any(type_uses_result)),
    }
}

fn type_uses_result(expr: &TypeExpr) -> bool {
    match expr {
        TypeExpr::Var(_) => false,
        TypeExpr::App { name, args } => {
            if name == "Result" {
                return true;
            }
            args.iter().any(type_uses_result)
        }
        TypeExpr::Tuple(items) => items.iter().any(type_uses_result),
        TypeExpr::Record(fields) => {
            fields.iter().any(|(_, expr)| type_uses_result(expr))
        }
    }
}

fn render_def(def: &TypeDef) -> String {
    match def {
        TypeDef::Alias { name, expr } => {
            let body = format_type(expr, 0, TypeFormat::Multiline);
            format!("export type {name} = {body};")
        }
        TypeDef::Union { name, variants } => render_union(name, variants),
    }
}

fn render_union(name: &str, variants: &[Variant]) -> String {
    let mut lines = Vec::new();
    lines.push(format!("export type {name} ="));

    for variant in variants {
        lines.push(format!("  | {}", render_variant(variant)));
    }

    lines.push(";".to_string());
    lines.join("\n")
}

fn render_variant(variant: &Variant) -> String {
    if variant.args.is_empty() {
        format!("'{}'", variant.name)
    } else if variant.args.len() == 1 {
        let arg = format_type(&variant.args[0], 0, TypeFormat::Inline);
        format!("{{ {}: {} }}", variant.name, arg)
    } else {
        let args = variant
            .args
            .iter()
            .map(|arg| format_type(arg, 0, TypeFormat::Inline))
            .collect::<Vec<_>>()
            .join(", ");
        format!("{{ {}: [{}] }}", variant.name, args)
    }
}

#[derive(Copy, Clone)]
enum TypeFormat {
    Inline,
    Multiline,
}

fn format_type(expr: &TypeExpr, indent: usize, format: TypeFormat) -> String {
    match expr {
        TypeExpr::Var(name) => map_var(name),
        TypeExpr::App { name, args } => format_app(name, args, indent),
        TypeExpr::Tuple(items) => {
            let rendered = items
                .iter()
                .map(|item| format_type(item, indent, TypeFormat::Inline))
                .collect::<Vec<_>>()
                .join(", ");
            format!("[{}]", rendered)
        }
        TypeExpr::Record(fields) => format_record(fields, indent, format),
    }
}

fn map_var(name: &str) -> String {
    match name {
        "String" => "string".to_string(),
        "Int" | "Float" => "number".to_string(),
        "Bool" => "boolean".to_string(),
        other => other.to_string(),
    }
}

fn format_app(name: &str, args: &[TypeExpr], indent: usize) -> String {
    match (name, args.len()) {
        ("Maybe", 1) => format!(
            "{} | null",
            format_type(&args[0], indent, TypeFormat::Inline)
        ),
        ("List", 1) => format!(
            "Array<{}>",
            format_type(&args[0], indent, TypeFormat::Inline)
        ),
        ("Dict", 2) => format!(
            "Record<string, {}>",
            format_type(&args[1], indent, TypeFormat::Inline)
        ),
        ("Set", 1) => format!(
            "Array<{}>",
            format_type(&args[0], indent, TypeFormat::Inline)
        ),
        ("Result", 2) => format!(
            "Result<{}, {}>",
            format_type(&args[0], indent, TypeFormat::Inline),
            format_type(&args[1], indent, TypeFormat::Inline)
        ),
        _ => {
            if args.is_empty() {
                name.to_string()
            } else {
                let rendered = args
                    .iter()
                    .map(|arg| format_type(arg, indent, TypeFormat::Inline))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("{}<{}>", name, rendered)
            }
        }
    }
}

fn format_record(
    fields: &[(String, TypeExpr)],
    indent: usize,
    format: TypeFormat,
) -> String {
    match format {
        TypeFormat::Inline => format_record_inline(fields, indent),
        TypeFormat::Multiline => format_record_multiline(fields, indent),
    }
}

fn format_record_inline(
    fields: &[(String, TypeExpr)],
    indent: usize,
) -> String {
    let rendered = fields
        .iter()
        .map(|(name, expr)| {
            let field_name = format_field_name(name);
            let field_type = format_type(expr, indent, TypeFormat::Inline);
            format!("{field_name}: {field_type}")
        })
        .collect::<Vec<_>>()
        .join("; ");
    format!("{{ {rendered} }}")
}

fn format_record_multiline(
    fields: &[(String, TypeExpr)],
    indent: usize,
) -> String {
    let indent_str = " ".repeat(indent);
    let field_indent = " ".repeat(indent + 2);
    let mut out = String::new();
    out.push_str("{\n");

    for (name, expr) in fields {
        let field_name = format_field_name(name);
        let field_type = format_type(expr, indent + 2, TypeFormat::Inline);
        out.push_str(&format!("{field_indent}{field_name}: {field_type};\n"));
    }

    out.push_str(&format!("{indent_str}}}"));
    out
}

fn format_field_name(name: &str) -> String {
    if is_valid_ts_ident(name) {
        name.to_string()
    } else {
        format!("\"{}\"", name)
    }
}

fn is_valid_ts_ident(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
}
