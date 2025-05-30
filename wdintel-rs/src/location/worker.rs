use crate::entities::sigint_peleng::Model;
use crate::entities::{freq_location, sigint_inbox_item, sigint_peleng};
use crate::location::utils::{format_locations_list, to_location_list};
use crate::location::*;
use milgeo_rs::coord_util::{LatLng, Locality};
use milgeo_rs::MilGeo;

pub async fn process_location_v2_coords_worker(
    dbx: &DatabaseConnection,
    mil_geo: MilGeo,
) {
    debug!("starting process_location_v2_coords_worker");
    loop {
        if let Err(e) = run_process_coords_locations_worker(dbx, &mil_geo).await
        {
            error!("process_location_v2_coords_worker error: {}", e);
        }
        // println!(
        //     "[process_location_v2_coords_worker] nothing to do, sleeping..."
        // );
        tokio::time::sleep(tokio::time::Duration::from_secs(10)).await;
    }
}

pub async fn run_process_coords_locations_worker(
    dbx: &DatabaseConnection,
    mil_geo: &MilGeo,
) -> anyhow::Result<()> {
    let mut offset = 0;
    loop {
        let mut select = sigint_peleng::Entity::find()
            .filter(sigint_peleng::Column::Settlement.is_null())
            .order_by_desc(sigint_peleng::Column::CreatedAt);
        if offset > 0 {
            select = select.offset(offset);
        }
        match select.one(dbx).await.context(h!())? {
            None => {
                return Ok(());
            }
            Some(peleng) => {
                let Some(inbox_item) = sigint_inbox_item::Entity::find()
                    .filter(
                        sigint_inbox_item::Column::Id
                            .eq(peleng.source_inbox_item_id),
                    )
                    .one(dbx)
                    .await
                    .context(h!())?
                else {
                    error!("[run_process_coords_locations_worker] failed to find inbox item {}", peleng.source_inbox_item_id);
                    offset += 1;
                    continue;
                };
                let pelengs = sigint_peleng::Entity::find()
                    .filter(sigint_peleng::Column::Settlement.is_null())
                    .filter(
                        sigint_peleng::Column::SourceInboxItemId
                            .eq(peleng.source_inbox_item_id),
                    )
                    .all(dbx)
                    .await?;
                let peleng_locations =
                    collect_peleng_locations(pelengs, mil_geo).await?;
                let locations = peleng_locations
                    .clone()
                    .into_iter()
                    .filter_map(|x| x.1.into_iter().next())
                    .map(|x| x.settlement_name.to_uppercase())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect_vec();
                let mut new_locations = match inbox_item.location_v2.as_ref() {
                    None => vec![],
                    Some(loc) => to_location_list(loc),
                };
                let mut existing_locations =
                    new_locations.clone().into_iter().collect::<BTreeSet<_>>();
                if let (Some(freq), Some(datetime)) =
                    (inbox_item.freq.clone(), inbox_item.datetime.clone())
                {
                    push_frequency_locations(
                        &locations,
                        freq,
                        datetime,
                        dbx,
                        &peleng_locations,
                    )
                    .await
                    .context(h!())?;
                }
                for l in locations.iter() {
                    if !existing_locations.contains(l) {
                        new_locations.push(l.clone());
                        existing_locations.insert(l.clone());
                    }
                }
                let location_v2 = Some(format_locations_list(new_locations));
                let mut model = inbox_item.clone().into_active_model();
                model.location_v2 = Set(location_v2);
                model.update(dbx).await.context(h!())?;
                for (peleng, localities) in peleng_locations.clone() {
                    let mut model = peleng.into_active_model();
                    if let Some(locality) = localities.into_iter().next() {
                        model.country_code = Set(Some(String::from(
                            locality.get_country_code(),
                        )));
                        model.settlement =
                            Set(Some(locality.settlement_name.clone()));
                        model.distance_m = Set(Some(locality.distance_m));
                        model.locality_direction =
                            Set(Some(locality.direction));
                    } else {
                        model.settlement = Set(Some(String::from("")));
                    }
                    model.update(dbx).await.context(h!())?;
                }
            }
        }
    }
}

async fn push_frequency_locations<'a, 'async_trait, C>(
    locations: &Vec<String>,
    freq: String,
    ts: NaiveDateTime,
    txn: &'a C,
    peleng_locations: &Vec<(Model, Vec<Locality>)>,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let mut locations = locations.clone().into_iter().collect::<BTreeSet<_>>();
    for (_, localities) in peleng_locations {
        for l in localities {
            locations.insert(l.settlement_name.clone());
        }
    }
    for location in locations {
        let location = location.to_uppercase();
        let m_existing = freq_location::Entity::find()
            .filter(freq_location::Column::Location.eq(location.clone()))
            .filter(freq_location::Column::Freq.eq(freq.clone()))
            .filter(freq_location::Column::Deleted.eq(false))
            .one(txn)
            .await
            .context(h!())?;
        match m_existing {
            None => {
                freq_location::ActiveModel {
                    id: NotSet,
                    freq: Set(freq.clone()),
                    location: Set(location.clone()),
                    datetime: Set(Some(ts)),
                    deleted: NotSet,
                    created_at: NotSet,
                }
                .insert(txn)
                .await
                .context(h!())?;
            }
            Some(model) => {
                let mut model = model.into_active_model();
                model.datetime = Set(Some(ts));
                model.update(txn).await.context(h!())?;
            }
        }
    }
    Ok(())
}

async fn collect_peleng_locations(
    pelengs: Vec<sigint_peleng::Model>,
    mil_geo: &MilGeo,
) -> anyhow::Result<Vec<(sigint_peleng::Model, Vec<Locality>)>> {
    let mut coords = BTreeMap::new();
    let mut pelengs_map = BTreeMap::new();
    for peleng in pelengs.into_iter() {
        coords.insert(
            peleng.id,
            LatLng {
                lat: peleng.lat,
                lng: peleng.lng,
            },
        );
        pelengs_map.insert(peleng.id, peleng);
    }
    let matches =
        milgeo_rs::coord_util::map_coords(coords.clone(), mil_geo.clone(), 3)
            .await
            .context(h!())?;
    let mut data = vec![];
    for (id, locality) in matches {
        if let Some(peleng) = pelengs_map.get(&id) {
            data.push((peleng.clone(), locality));
        }
    }

    Ok(data)
}
