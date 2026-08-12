use crate::entities::*;
use crate::h;
use crate::types::ShortContext;
use crate::types::*;
use crate::AppError;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use sea_orm::*;
use sea_query::Expr;
use serde::{Deserialize, Serialize};
use std::hash::Hash;

use super::body_noheader::NoHeadersBody;

#[derive(Debug, FromQueryResult)]
struct SignalRes {
    id: i64,
    text: String,
    highlighted_text: String,
}

async fn generate_ts_vector<'a, 'async_trait, C>(
    txn: &'a C,
    body: &str,
) -> Result<String, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let stmt = Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "SELECT to_tsvector('russian', $1)::TEXT AS ts_vector",
        [body.into()],
    );

    let result = txn.query_one_raw(stmt).await.c(h!())?;

    if let Some(row) = result {
        let ts_vector: String = row.try_get("", "ts_vector").c(h!())?;
        Ok(ts_vector)
    } else {
        Err(AppError::BL {
            msg: "No ts_vector generated".to_string(),
        })
    }
}

pub async fn find_signal_tokens<'a, 'async_trait, C>(
    txn: &'a C,
    body: &str,
    body_noheader: &NoHeadersBody,
) -> Result<Vec<CNSignal>, AppError>
where
    C: ConnectionTrait + 'async_trait,
{
    let ts_vector = generate_ts_vector(txn, body).await.c(h!())?;

    let q = sigint_signal::Entity::find()
        .select_only()
        .column(sigint_signal::Column::Id)
        .column(sigint_signal::Column::Text)
        .column_as(
            Expr::cust_with_values(
                "ts_headline('russian', $1, websearch_to_tsquery('russian', sigint_signal.text), 'HighlightAll=true')",
                [body]
            ),
            "highlighted_text",
        )
        .filter(sigint_signal::Column::Deleted.eq(false))
        .filter(
            Expr::cust_with_values(
                "$1::tsvector @@ websearch_to_tsquery('russian', sigint_signal.text)",
                [ts_vector],
            ),
        );

    trace!(
        ">find and highlight signals query: {}",
        q.build(DbBackend::Postgres)
    );

    let signals = q.into_model::<SignalRes>().all(txn).await.c(h!())?;

    trace!(">found signals: {}", signals.len());

    extract_highlighted_tokens(signals, body, body_noheader)
}

fn extract_highlighted_tokens(
    signals: Vec<SignalRes>,
    body: &str,
    body_noheader: &NoHeadersBody,
) -> Result<Vec<CNSignal>, AppError> {
    let mut res = Vec::new();

    for signal in signals {
        let keywords =
            crate::rer_importer::highlight::extract_ts_headline_keywords_exact(
                body,
                Some(body_noheader.start),
                signal.highlighted_text.as_str(),
            )?;

        for keyword in keywords {
            res.push(CNSignal {
                id: signal.id,
                etalon: signal.text.clone(),
                text: keyword.text.to_string(),
                begin: keyword.begin,
                end: keyword.end,
            });
        }
    }

    trace!(">extracted signals: {:?}", res);

    Ok(res)
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Clone,
    PartialOrd,
    Ord,
    Hash,
    Eq,
)]
pub struct CNSignal {
    pub begin: usize,
    pub end: usize,
    pub etalon: String,
    pub text: String,
    pub id: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn extract_highlighted_tokens_01() {
        let body = "Клевер, передай Боксу, по Тереку на юг к Боксу, баба яга. за боксом справа";
        let body_noheader = NoHeadersBody{body: "Клевер, передай Боксу, по Тереку на юг к Боксу, баба яга. за боксом справа".to_string(), 
        start: 0,
        end: 62,};
        let signals = vec![
            SignalRes {
                id: 1,
                text: "Клевер".to_string(),
                highlighted_text: "<b>Клевер</b>, передай Боксу, по Тереку на юг к Боксу, баба яга. за боксом справа".to_string(),                
            },
            SignalRes {
                id: 2,
                text: "Бокс".to_string(),
                highlighted_text: "Клевер, передай <b>Боксу</b>, по Тереку на юг к <b>Боксу</b>, баба яга. за <b>боксом</b> справа".to_string(),
            },
        ];

        let result =
            extract_highlighted_tokens(signals, body, &body_noheader).unwrap();
        assert_eq!(result.len(), 4);
        assert_eq!(result[0].text, "Клевер");
        assert_eq!(result[0].etalon, "Клевер");
        assert_eq!(result[0].begin, 0);
        assert_eq!(result[0].end, 6);
        assert_eq!(result[1].text, "Боксу");
        assert_eq!(result[1].etalon, "Бокс");
        assert_eq!(result[1].begin, 16);
        assert_eq!(result[1].end, 21);
        assert_eq!(result[2].text, "Боксу");
        assert_eq!(result[2].etalon, "Бокс");
        assert_eq!(result[2].begin, 41);
        assert_eq!(result[2].end, 46);
        assert_eq!(result[3].text, "боксом");
        assert_eq!(result[3].etalon, "Бокс");
        assert_eq!(result[3].begin, 61);
        assert_eq!(result[3].end, 67);
    }

    #[tokio::test]
    async fn extract_highlighted_tokens_02() {
        let body = "- Отвага я Гора по Омску Буран-40 север - сев.-запад.";
        let body_noheader = NoHeadersBody {
            body: "- Отвага я Гора по Омску Буран-40 север - сев.-запад."
                .to_string(),
            start: 0,
            end: 48,
        };
        let signals = vec![
            SignalRes {
                id: 1,
                text: "Буран-40".to_string(),
                highlighted_text: "- Отвага я Гора по Омску <b>Буран</b><b>-40</b> север - сев.-запад.".to_string(),                
            },
        ];

        let result =
            extract_highlighted_tokens(signals, body, &body_noheader).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].text, "Буран");
        assert_eq!(result[0].etalon, "Буран-40");
        assert_eq!(result[0].begin, 25);
        assert_eq!(result[0].end, 30);
        assert_eq!(result[1].text, "-40");
        assert_eq!(result[1].etalon, "Буран-40");
        assert_eq!(result[1].begin, 30);
        assert_eq!(result[1].end, 33);
    }

    #[tokio::test]
    async fn extract_highlighted_tokens_03() {
        let body = r#"444.1250
J
21.45
az-120°
УКХ радіомережа невизначеного підрозділу
напрямок НАДІЇВКА - СРІБНЕ (уточнюється)



— я вам скотчем примотаю ету рацию блядь
— что ты сейчас говоришь"#;
        let body_noheader = NoHeadersBody {
            body: "J\n20.30\naz-120°\nнапрямок НАДІЇВКА - СРІБНЕ (уточнюється)\n\n\n\n— я вам скотчем примотаю ету рацию блядь\n— что ты сейчас говоришь"
                .to_string(),
            start: 0,
            end: 125,
        };
        let signals = vec![SignalRes {
            id: 1,
            text: "скотч".to_string(),
            highlighted_text: r#"444.1250
J
21.45
az-120°
УКХ радіомережа невизначеного підрозділу
напрямок НАДІЇВКА - СРІБНЕ (уточнюється)



— я вам <b>скотчем</b> примотаю ету рацию блядь
— что ты сейчас говоришь"#
                .to_string(),
        }];

        let result =
            extract_highlighted_tokens(signals, body, &body_noheader).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].text, "скотчем");
        assert_eq!(result[0].etalon, "скотч");
        assert_eq!(result[0].begin, 118);
        assert_eq!(result[0].end, 125);
    }
}
