use crate::config::LOCATION_SEARCH_LIMIT;
use crate::error::AppError;
use crate::types::*;
use sea_orm::{ConnectionTrait, DbBackend, Statement};

pub async fn search<C>(
    dbx: &C,
    search_phrase: &str,
) -> Result<Vec<String>, AppError>
where
    C: ConnectionTrait,
{
    let prefix = format!("{}%", escape_like(search_phrase));
    let rows = dbx
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"
                select distinct location_v2 collate "C" as location_v2
                from sigint_inbox_item
                where location_v2 is not null
                  and location_v2 <> ''
                  and location_v2 collate "C" like $1 escape '\'
                order by location_v2 collate "C"
                limit $2
            "#,
            [prefix.into(), LOCATION_SEARCH_LIMIT.into()],
        ))
        .await
        .c(h!())?;

    rows.into_iter()
        .map(|row| -> Result<String, AppError> {
            Ok(row.try_get("", "location_v2").context(h!())?)
        })
        .collect()
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
