use crate::entities::*;
use sea_orm::sea_query::{Expr, Query, SelectStatement, SimpleExpr};
use sea_orm::ColumnTrait;

fn quote_identifier(ident: &str) -> String {
    let escaped = ident.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

fn preferred_sender_sql(table_alias: Option<&str>) -> String {
    let table = table_alias.map(quote_identifier).unwrap_or_else(|| {
        // default table name
        "\"signal_message\"".to_string()
    });
    format!(
        "coalesce((SELECT coalesce(sender, login_id::text) \
         FROM signal_message_group \
         WHERE signal_message_group.signal_message_id = {table}.id \
           AND (sender IS NOT NULL OR login_id IS NOT NULL) \
         ORDER BY signal_message_group.id ASC LIMIT 1), \
         {table}.login_id::text)"
    )
}

/// Returns an expression that selects the preferred sender from signal_message_group
/// for the given signal_message table alias (or the base table if None).
pub fn preferred_sender_expr(table_alias: Option<&str>) -> SimpleExpr {
    Expr::cust(preferred_sender_sql(table_alias))
}

/// Builds a subquery that returns message ids which have any sender from the provided list.
pub fn message_ids_for_senders(senders: &[String]) -> SelectStatement {
    Query::select()
        .column(signal_message_group::Column::SignalMessageId)
        .from(signal_message_group::Entity)
        .and_where(
            signal_message_group::Column::Sender.eq_any(senders.to_vec()),
        )
        .to_owned()
}

/// Returns SQL snippet used for manual expression composition.
pub fn preferred_sender_sql_snippet(table_alias: Option<&str>) -> String {
    preferred_sender_sql(table_alias)
}
