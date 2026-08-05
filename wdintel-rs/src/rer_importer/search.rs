use crate::error::AppError;
use crate::types::*;
use chrono::prelude::*;

pub async fn oneoff_reprocess_search_index(
    mode: Mode,
    ps: &crate::OneoffReprocessSearchIndexPs,
) -> Result<(), AppError> {
    let start_dt = ps
        .start
        .as_deref()
        .map(|dt| {
            NaiveDateTime::parse_from_str(dt, "%Y-%m-%dT%H:%M:%S").c(h!())
        })
        .transpose()
        .c(h!())?;
    let end_dt = ps
        .end
        .as_deref()
        .map(|dt| {
            NaiveDateTime::parse_from_str(dt, "%Y-%m-%dT%H:%M:%S").c(h!())
        })
        .transpose()
        .c(h!())?;
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;

    let pool = dbx.get_postgres_connection_pool();

    let delete_query = "DELETE FROM sigint_search ss WHERE ss.id IN (SELECT sii.id FROM sigint_inbox_item sii JOIN signal_message sm ON sii.id = sm.id";
    let insert_query = "INSERT INTO sigint_search (id, search_tsv) SELECT sii.id, to_tsvector('russian', sii.body_noheader->>'body') FROM sigint_inbox_item sii JOIN signal_message sm ON sii.id = sm.id";

    let (where_clause, limit_clause) = match (start_dt, end_dt) {
        (Some(_), Some(_)) => (
            "WHERE created_at >= $1 AND created_at < $2".to_string(),
            "LIMIT $3".to_string(),
        ),
        (Some(_), None) => {
            ("WHERE created_at >= $1".to_string(), "LIMIT $2".to_string())
        }
        (None, Some(_)) => {
            ("WHERE created_at < $1".to_string(), "LIMIT $2".to_string())
        }
        (None, None) => ("WHERE 1=1".to_string(), "".to_string()), // No filtering, select all documents
    };

    let full_delete_query =
        format!("{delete_query} {where_clause} {limit_clause})");
    let full_insert_query = format!("{insert_query} {where_clause}");

    // println!("Full delete query: {}", full_delete_query);

    let batch_size = 100_000;
    match (start_dt, end_dt) {
        (Some(start), Some(end)) => {
            loop {
                let deleted_rows = sqlx::query(sqlx::AssertSqlSafe(
                    full_delete_query.as_str(),
                ))
                .bind(start)
                .bind(end)
                .bind(batch_size)
                .execute(pool)
                .await
                .c(h!())?;
                if deleted_rows.rows_affected() == 0 {
                    break;
                }

                println!("Deleted {} rows...", deleted_rows.rows_affected());
            }
            sqlx::query(sqlx::AssertSqlSafe(full_insert_query.as_str()))
                .bind(start)
                .bind(end)
                .execute(pool)
                .await
                .c(h!())?;
        }
        (Some(start), None) => {
            loop {
                let deleted_rows = sqlx::query(sqlx::AssertSqlSafe(
                    full_delete_query.as_str(),
                ))
                .bind(start)
                .bind(batch_size)
                .execute(pool)
                .await
                .c(h!())?;
                if deleted_rows.rows_affected() == 0 {
                    break;
                }

                println!("Deleted {} rows...", deleted_rows.rows_affected());
            }
            sqlx::query(sqlx::AssertSqlSafe(full_insert_query.as_str()))
                .bind(start)
                .execute(pool)
                .await
                .c(h!())?;
        }
        (None, Some(end)) => {
            loop {
                let deleted_rows = sqlx::query(sqlx::AssertSqlSafe(
                    full_delete_query.as_str(),
                ))
                .bind(end)
                .bind(batch_size)
                .execute(pool)
                .await
                .c(h!())?;
                if deleted_rows.rows_affected() == 0 {
                    break;
                }

                println!("Deleted {} rows...", deleted_rows.rows_affected());
            }
            sqlx::query(sqlx::AssertSqlSafe(full_insert_query.as_str()))
                .bind(end)
                .execute(pool)
                .await
                .c(h!())?;
        }
        (None, None) => {
            sqlx::query(sqlx::AssertSqlSafe(full_delete_query.as_str()))
                .execute(pool)
                .await
                .c(h!())?;
            sqlx::query(sqlx::AssertSqlSafe(full_insert_query.as_str()))
                .execute(pool)
                .await
                .c(h!())?;
        }
    }

    println!("Sigint Search index updated successfully.");

    Ok(())
}
