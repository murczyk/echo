use crate::entities::*;
use crate::error::AppError;
use crate::types::*;
use actix_web::web::Json;
use sea_orm::*;
use std::io::BufRead;

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct JsonCallsign {
    pub name: String,
    pub position: Option<String>,
    pub comment: Option<String>,
    pub freq: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct JsonUnit {
    pub name: String,
    pub company: Option<String>,
    pub regiment: Option<String>,
    pub division: Option<String>,
    pub army: Option<String>,
    pub battalion: Option<String>,
    pub comment: Option<String>,
    pub callsigns: Vec<JsonCallsign>,
}

#[tokio::main]
pub async fn export_unit(
    mode: Mode,
    ps: &crate::ExportUnitPs,
) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await?;

    println!(
        "{}",
        serde_json::to_string_pretty(&Json(
            sigint_unit::Entity::find()
                .find_with_related(sigint_callsign::Entity)
                .filter(sigint_unit::Column::Deleted.eq(false))
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
                .await?
                .into_iter()
                .map(|(u, cs)| JsonUnit {
                    name: u.name.clone(),
                    company: Some(u.company.clone()).filter(|x| !x.is_empty()),
                    regiment: Some(u.regiment.clone())
                        .filter(|x| !x.is_empty()),
                    division: Some(u.division.clone())
                        .filter(|x| !x.is_empty()),
                    army: Some(u.army.clone()).filter(|x| !x.is_empty()),
                    battalion: Some(u.battalion.clone())
                        .filter(|x| !x.is_empty()),
                    comment: Some(u.comment.clone()).filter(|x| !x.is_empty()),
                    callsigns: cs
                        .into_iter()
                        .map(|c| JsonCallsign {
                            name: c.callsign.clone(),
                            position: Some(c.position)
                                .filter(|x| !x.is_empty()),
                            comment: Some(c.comment).filter(|x| !x.is_empty()),
                            freq: Some(c.radio_freq).filter(|x| !x.is_empty()),
                        })
                        .collect(),
                })
                .collect::<Vec<JsonUnit>>()
        ))
        .unwrap()
    );

    Ok(())
}

#[tokio::main]
pub async fn import_unit(
    mode: Mode,
    ps: &crate::ImportUnitPs,
) -> Result<(), AppError> {
    let dbx = crate::new_pg_pool_from_mode(mode).await?;

    let mut json_units = String::new();
    for line in std::io::stdin().lock().lines() {
        json_units.push_str(&line?);
    }

    let json_units: Vec<JsonUnit> =
        serde_json::from_str(&json_units).context(h!())?;

    let mut unit_id: i64;
    for json_unit in json_units.iter() {
        let unit_res = sigint_unit::Entity::find()
            .filter(sigint_unit::Column::Name.eq(&json_unit.name))
            .one(&dbx)
            .await?;

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

                unit.update(&dbx).await?;
            }
        } else {
            let insert_res =
                sigint_unit::Entity::insert(sigint_unit::ActiveModel {
                    id: NotSet,
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
                    created_by: Set(login::Entity::find()
                        .one(&dbx)
                        .await?
                        .unwrap()
                        .login), // TODO: any login
                    ..Default::default()
                })
                .exec(&dbx)
                .await?;
            unit_id = insert_res.last_insert_id;
        }

        for json_callsign in json_unit.callsigns.iter() {
            let callsign_res = sigint_callsign::Entity::find()
                .filter(sigint_callsign::Column::UnitId.eq(unit_id))
                .filter(
                    sigint_callsign::Column::Callsign.eq(&json_callsign.name),
                )
                .one(&dbx)
                .await?;

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

                callsign.update(&dbx).await?;
            } else {
                sigint_callsign::Entity::insert(sigint_callsign::ActiveModel {
                    id: NotSet,
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
                    source_id: Set(1), // TODO: hardcoded
                    ..Default::default()
                })
                .exec(&dbx)
                .await
                .unwrap();
            }
        }
    }
    Ok(())
}
