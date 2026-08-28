use crate::entities::*;
use sea_orm::sea_query::{Expr, Query, SelectStatement, SimpleExpr};
use sea_orm::ExprTrait;

fn quote_identifier(ident: &str) -> String {
    let escaped = ident.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

fn nullable_login_id_text_sql(table: &str) -> String {
    // pg_clickhouse evaluates nullable UUID-to-text casts before COALESCE.
    format!(
        "case when {table}.login_id is null then null else \
         {table}.login_id::text end"
    )
}

fn preferred_author_sql(table: &str) -> String {
    let login_id = nullable_login_id_text_sql(table);
    format!("coalesce({table}.sender, {login_id})")
}

fn preferred_sender_sql(table_alias: Option<&str>) -> String {
    let table = table_alias.map(quote_identifier).unwrap_or_else(|| {
        // default table name
        "\"signal_message\"".to_string()
    });
    let group_sender = preferred_author_sql("signal_message_group");
    let message_login_id = nullable_login_id_text_sql(&table);
    format!(
        "coalesce((SELECT {group_sender} \
         FROM signal_message_group \
         WHERE signal_message_group.signal_message_id = {table}.id \
           AND (sender IS NOT NULL OR login_id IS NOT NULL) \
         ORDER BY signal_message_group.id ASC LIMIT 1), \
         {message_login_id})"
    )
}

fn preferred_group_sender_sql(table_alias: Option<&str>) -> String {
    let table = table_alias
        .map(quote_identifier)
        .unwrap_or_else(|| "\"signal_message_group\"".to_string());
    preferred_author_sql(&table)
}

fn preferred_message_author_sql(table_alias: Option<&str>) -> String {
    let table = table_alias
        .map(quote_identifier)
        .unwrap_or_else(|| "\"signal_message\"".to_string());
    preferred_author_sql(&table)
}

/// Returns an expression that selects the preferred sender from signal_message_group
/// for the given signal_message table alias (or the base table if None).
pub fn preferred_sender_expr(table_alias: Option<&str>) -> SimpleExpr {
    Expr::cust(preferred_sender_sql(table_alias))
}

pub fn preferred_group_sender_expr(table_alias: Option<&str>) -> SimpleExpr {
    Expr::cust(preferred_group_sender_sql(table_alias))
}

pub fn preferred_message_author_expr(table_alias: Option<&str>) -> SimpleExpr {
    Expr::cust(preferred_message_author_sql(table_alias))
}

/// Builds a subquery that returns message ids which have any sender from the provided list.
pub fn message_ids_for_senders(senders: &[String]) -> SelectStatement {
    Query::select()
        .column(signal_message_group::Column::SignalMessageId)
        .from(signal_message_group::Entity)
        .and_where(preferred_group_sender_expr(None).is_in(senders.to_vec()))
        .to_owned()
}

/// Returns SQL snippet used for manual expression composition.
pub fn preferred_sender_sql_snippet(table_alias: Option<&str>) -> String {
    preferred_sender_sql(table_alias)
}
