use crate::config::*;
use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use actix_web::web::Json;
use sea_orm::*;
use std::io::BufRead;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct JsonCallsign {
    pub id: i64,
    pub name: String,
    pub position: Option<String>,
    pub comment: Option<String>,
    pub freq: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct JsonSignal {
    pub id: i64,
    pub text: String,
    pub meaning: Option<String>,
    pub coordinates: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct JsonUnit {
    pub id: i64,
    pub name: String,
    pub company: Option<String>,
    pub regiment: Option<String>,
    pub division: Option<String>,
    pub army: Option<String>,
    pub battalion: Option<String>,
    pub comment: Option<String>,
    pub callsigns: Vec<JsonCallsign>,
    pub signals: Vec<JsonSignal>,
}

pub async fn export_unit(
    mode: Mode,
    ps: &crate::ExportUnitPs,
) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let mut unit_ids = vec![];

    let units_with_callsigns = sigint_unit::Entity::find()
        .find_with_related(sigint_callsign::Entity)
        .filter(sigint_unit::Column::Deleted.eq(false))
        .apply_if(ps.name.as_ref(), |q, x| {
            q.filter(sigint_unit::Column::Name.contains(x))
        })
        .apply_if(ps.company.as_ref(), |q, x| {
            q.filter(sigint_unit::Column::Company.eq(x))
        })
        .apply_if(ps.division.as_ref(), |q, x| {
            q.filter(sigint_unit::Column::Division.eq(x))
        })
        .apply_if(ps.regiment.as_ref(), |q, x| {
            q.filter(sigint_unit::Column::Regiment.eq(x))
        })
        .apply_if(ps.army.as_ref(), |q, x| {
            q.filter(sigint_unit::Column::Army.eq(x))
        })
        .apply_if(ps.battalion.as_ref(), |q, x| {
            q.filter(sigint_unit::Column::Battalion.eq(x))
        })
        .all(&dbx)
        .await
        .c(h!())?
        .into_iter()
        .map(|(u, cs)| {
            unit_ids.push(u.id);
            JsonUnit {
                id: u.id,
                name: u.name.clone(),
                company: Some(u.company.clone()).filter(|x| !x.is_empty()),
                regiment: Some(u.regiment.clone()).filter(|x| !x.is_empty()),
                division: Some(u.division.clone()).filter(|x| !x.is_empty()),
                army: Some(u.army.clone()).filter(|x| !x.is_empty()),
                battalion: Some(u.battalion.clone()).filter(|x| !x.is_empty()),
                comment: Some(u.comment.clone()).filter(|x| !x.is_empty()),
                callsigns: cs
                    .into_iter()
                    .map(|c| JsonCallsign {
                        id: c.id,
                        name: c.callsign.clone(),
                        position: Some(c.position).filter(|x| !x.is_empty()),
                        comment: Some(c.comment).filter(|x| !x.is_empty()),
                        freq: Some(c.radio_freq).filter(|x| !x.is_empty()),
                    })
                    .collect(),
                signals: vec![],
            }
        })
        .collect::<Vec<JsonUnit>>();
    let mut result = vec![];
    let all_signals = sigint_signal::Entity::find()
        .filter(sigint_signal::Column::Deleted.eq(false))
        .filter(sigint_signal::Column::Unit.is_in(unit_ids))
        .all(&dbx)
        .await
        .c(h!())?;

    for mut unit in units_with_callsigns {
        let unit_id = unit.id;
        let signals = all_signals
            .iter()
            .filter(|s| s.unit.filter(|u| unit_id.eq(u)).is_some())
            .cloned()
            .map(|s| JsonSignal {
                id: s.id,
                text: s.text,
                meaning: s.meaning,
                coordinates: s.coordinates,
            })
            .collect_vec();
        unit.signals = signals;
        result.push(unit);
    }
    let content = serde_json::to_string_pretty(&Json(result)).c(h!())?;
    println!("result: \n{content}");
    if let Some(path) = &ps.dest_path {
        let mut file = File::create(path.clone()).await.c(h!())?;
        file.write_all(content.as_bytes()).await.c(h!())?;
        info!("done writing result to {path}")
    } else {
        info!("skipping writing result to file. \npass dest_path variable if you want to write it to filesystem.")
    }
    Ok(())
}

pub async fn import_unit(
    mode: Mode,
    ps: &crate::ImportUnitPs,
) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await.c(h!())?;
    let sigint_origin_id = sigint_origin::Entity::find()
        .filter(sigint_origin::Column::Name.eq(ps.origin.to_string()))
        .one(&dbx)
        .await
        .c(h!())?
        .map(|o| o.id)
        .c(h!())?;

    let json_units = if let Some(src_path) = ps.src_path.to_owned() {
        info!("importing unit from {src_path}");
        let mut file_read = File::open(src_path).await.c(h!())?;
        let mut buffer = Vec::new();
        file_read.read_to_end(&mut buffer).await.c(h!())?;
        String::from_utf8_lossy(&buffer).to_string()
    } else {
        info!("paste your unit json:");
        let mut json_units = String::new();
        for line in std::io::stdin().lock().lines() {
            json_units.push_str(&line?);
        }
        json_units
    };

    let json_units: Vec<JsonUnit> =
        serde_json::from_str(&json_units).c(h!())?;

    let mut unit_id: i64;
    for json_unit in json_units {
        let unit_res = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Name.eq(&json_unit.name))
            .one(&dbx)
            .await
            .c(h!())?;

        if let Some(unit) = unit_res {
            unit_id = unit.id;
            let mut unit: sigint_unit::ActiveModel = unit.into();
            if ps.upsert {
                if let Some(company) = &json_unit.company {
                    unit.company = Set(company.clone());
                }
                if let Some(regiment) = &json_unit.regiment {
                    unit.regiment = Set(regiment.clone());
                }
                if let Some(division) = &json_unit.division {
                    unit.division = Set(division.clone());
                }
                if let Some(army) = &json_unit.army {
                    unit.army = Set(army.clone());
                }
                if let Some(battalion) = &json_unit.battalion {
                    unit.battalion = Set(battalion.clone());
                }
                if let Some(comment) = &json_unit.comment {
                    unit.comment = Set(comment.clone());
                }
                info!("updating unit {unit_id}");
                unit.update(&dbx).await.c(h!())?;
            }
        } else {
            let insert_res =
                sigint_unit::Entity::insert(sigint_unit::ActiveModel {
                    id: NotSet,
                    original_id: Set(Some(json_unit.id)),
                    name: Set(json_unit.name.clone()),
                    company: Set(json_unit.company.clone().unwrap_or_default()),
                    regiment: Set(json_unit
                        .regiment
                        .clone()
                        .unwrap_or_default()),
                    division: Set(json_unit
                        .division
                        .clone()
                        .unwrap_or_default()),
                    army: Set(json_unit.army.clone().unwrap_or_default()),
                    battalion: Set(json_unit
                        .battalion
                        .clone()
                        .unwrap_or_default()),
                    comment: Set(json_unit.comment.clone().unwrap_or_default()),
                    created_by: Set(SYSTEM_LOGIN_NAME.to_string()),
                    sigint_origin_id: Set(Some(sigint_origin_id)),
                    ..Default::default()
                })
                .exec(&dbx)
                .await
                .c(h!())?;
            unit_id = insert_res.last_insert_id;
            info!("inserting unit {}", json_unit.name);
        }

        for json_callsign in json_unit.callsigns {
            let callsign_res = sigint_callsign::Entity::find()
                .filter(sigint_callsign::Column::UnitId.eq(unit_id))
                .filter(
                    sigint_callsign::Column::Callsign.eq(&json_callsign.name),
                )
                .one(&dbx)
                .await
                .c(h!())?;

            if let Some(callsign) = callsign_res {
                if !ps.upsert {
                    continue;
                }
                let mut callsign: sigint_callsign::ActiveModel =
                    callsign.into();
                if let Some(position) = &json_callsign.position {
                    callsign.position = Set(position.clone());
                }
                if let Some(comment) = &json_callsign.comment {
                    callsign.comment = Set(comment.clone());
                }
                if let Some(freq) = &json_callsign.freq {
                    callsign.radio_freq = Set(freq.clone());
                }

                callsign.update(&dbx).await.c(h!())?;
            } else {
                sigint_callsign::Entity::insert(sigint_callsign::ActiveModel {
                    id: NotSet,
                    original_id: Set(Some(json_callsign.id)),
                    callsign: Set(json_callsign.name.clone()),
                    position: Set(json_callsign
                        .position
                        .clone()
                        .unwrap_or_default()),
                    comment: Set(json_callsign
                        .comment
                        .clone()
                        .unwrap_or_default()),
                    radio_freq: Set(json_callsign
                        .freq
                        .clone()
                        .unwrap_or_default()),
                    unit_id: Set(unit_id),
                    sigint_origin_id: Set(Some(sigint_origin_id)),
                    source_id: Set(Some(1)), // TODO: hardcoded
                    ..Default::default()
                })
                .exec(&dbx)
                .await
                .c(h!())?;
            }
        }

        for json_signal in json_unit.signals {
            let signal_res = sigint_signal::Entity::find()
                .filter(sigint_signal::Column::Unit.eq(unit_id))
                .filter(sigint_signal::Column::Text.eq(&json_signal.text))
                .one(&dbx)
                .await
                .c(h!())?;

            if let Some(signal) = signal_res {
                if !ps.upsert {
                    continue;
                }
                let mut signal: sigint_signal::ActiveModel = signal.into();
                signal.coordinates = Set(json_signal.coordinates);
                signal.meaning = Set(json_signal.meaning);
                signal.update(&dbx).await.c(h!())?;
            } else {
                sigint_signal::Entity::insert(sigint_signal::ActiveModel {
                    id: NotSet,
                    original_id: Set(Some(json_signal.id)),
                    unit: Set(Some(unit_id)),
                    coordinates: Set(json_signal.coordinates),
                    meaning: Set(json_signal.meaning),
                    sigint_origin_id: Set(Some(sigint_origin_id)),
                    text: Set(json_signal.text),
                    ..Default::default()
                })
                .exec(&dbx)
                .await
                .c(h!())?;
            }
        }
    }
    Ok(())
}
