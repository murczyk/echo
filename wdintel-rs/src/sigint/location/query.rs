use crate::config::LOCATION_SEARCH_LIMIT;
use crate::entities::sigint_inbox_item;
use crate::error::AppError;
use crate::types::*;
use sea_orm::*;
use sea_query::{Alias, Expr, Order, SimpleExpr};

pub async fn search<C>(
    dbx: &C,
    search_phrase: &str,
) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait,
{
    let prefix = format!("{}%", escape_like(search_phrase));
    let normalized_location = Alias::new("normalized_location");

    Ok(sigint_inbox_item::Entity::find()
        .select_only()
        .column(sigint_inbox_item::Column::LocationV2)
        .column_as(normalized_location_expr(), "normalized_location")
        .filter(sigint_inbox_item::Column::LocationV2.is_not_null())
        .filter(sigint_inbox_item::Column::LocationV2.ne(""))
        .filter(Expr::cust_with_values(
            r#"lower("sigint_inbox_item"."location_v2") collate "C" like lower($1) collate "C" escape '\'"#,
            [prefix],
        ))
        .distinct_on([normalized_location.clone()])
        .order_by(Expr::col(normalized_location), Order::Asc)
        .order_by(location_expr(), Order::Asc)
        .limit(LOCATION_SEARCH_LIMIT)
        .into_tuple::<(Option<String>, String)>()
        .all(dbx)
        .await
        .c(h!())?
        .into_iter()
        .filter_map(|(location, _)| location)
        .collect())
}

fn normalized_location_expr() -> SimpleExpr {
    Expr::cust(r#"lower("sigint_inbox_item"."location_v2") collate "C""#)
}

fn location_expr() -> SimpleExpr {
    Expr::cust(r#""sigint_inbox_item"."location_v2" collate "C""#)
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

#[cfg(test)]
mod tests {
    use super::escape_like;

    #[test]
    fn escapes_like_metacharacters() {
        assert_eq!(escape_like(r"100%_safe\path"), r"100\%\_safe\\path");
    }
}
