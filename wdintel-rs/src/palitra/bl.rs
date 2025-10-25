use crate::entities::{login, palitra, palitra_point};
use crate::h;
use crate::palitra::types::*;
use crate::types::*;
use anyhow::Context;
use chrono::Utc;
use itertools::Itertools;
use sea_orm::prelude::*;
use sea_orm::*;

pub async fn update_palitra(
    palitra_id: i64,
    req: CreatePalitraReq,
    txn: &DatabaseTransaction,
) -> anyhow::Result<PalitraDetails> {
    let mut palitra = palitra::Entity::find_by_id(palitra_id)
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?
        .into_active_model();

    palitra = update_palitra_from_req(req, palitra);

    let palitra = palitra.update(txn).await.c(h!())?;
    let result = render_palitra_details(txn, vec![palitra])
        .await
        .c(h!())?
        .into_iter()
        .next()
        .c(h!())?;
    Ok(result)
}

pub async fn list_all_palitras_detailed(
    login: String,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<PalitraDetails>> {
    let palitra_models = collect_palitras(login, dbx).await.c(h!())?;
    let result = render_palitra_details(dbx, palitra_models).await.c(h!())?;
    Ok(result)
}

pub async fn list_all_palitras(
    login: String,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<Palitra>> {
    let palitra_models = collect_palitras(login, dbx).await.c(h!())?;
    let mut result = vec![];
    for model in palitra_models {
        let palitra = render_palitra(model)?;
        result.push(palitra);
    }
    Ok(result)
}

pub async fn delete_palitra(
    id: i64,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    palitra::Entity::update_many()
        .filter(palitra::Column::Id.eq(id))
        .filter(palitra::Column::Deleted.eq(false))
        .col_expr(palitra::Column::Deleted, Expr::value(true))
        .exec(txn)
        .await
        .c(h!())?;
    delete_existing_palitra_points(id, txn).await.c(h!())?;
    Ok(())
}

pub async fn create_palitra(
    author_login: String,
    req: CreatePalitraReq,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Palitra> {
    let model = palitra::ActiveModel {
        author: Set(Some(author_login)),
        ..Default::default()
    };
    let model = update_palitra_from_req(req, model);
    let palitra = model.insert(dbx).await.c(h!())?;
    render_palitra(palitra)
}

pub async fn recalculate_geometry<'a, 'async_trait, C>(
    txn: &'a C,
    palitra_id: i64,
) -> anyhow::Result<()>
where
    C: ConnectionTrait + 'async_trait,
{
    let center = calculate_center(txn, palitra_id).await.c(h!())?;
    let perimeter_linear_ring =
        calculate_convex_hull(txn, palitra_id).await.c(h!())?;
    let geometry: Geometry = Geometry {
        center,
        perimeter_linear_ring,
    };
    let mut model = palitra::Entity::find_by_id(palitra_id)
        .one(txn)
        .await
        .c(h!())?
        .c(h!())?
        .into_active_model();
    model.geometry = Set(Some(serde_json::to_value(&geometry).c(h!())?));
    model.update(txn).await.c(h!())?;
    Ok(())
}

async fn render_palitra_details<'a, 'async_trait, C>(
    txn: &'a C,
    palitra_models: Vec<palitra::Model>,
) -> anyhow::Result<Vec<PalitraDetails>>
where
    C: ConnectionTrait + 'async_trait,
{
    let ids = palitra_models.iter().map(|p| p.id).collect_vec();
    let points = palitra_point::Entity::find()
        .filter(palitra_point::Column::PalitraId.is_in(ids))
        .filter(palitra_point::Column::Deleted.eq(false))
        .all(txn)
        .await
        .c(h!())?;
    let mut result = vec![];
    for model in palitra_models {
        let points = points
            .iter()
            .filter(|p| p.palitra_id.eq(&model.id))
            .map(|p| PalitraPoint {
                label: p.label.clone(),
                coords: Coords {
                    lat: p.lat,
                    lng: p.lng,
                },
            })
            .collect_vec();
        let palitra = render_palitra(model)?;
        result.push(PalitraDetails { palitra, points });
    }
    Ok(result)
}

async fn calculate_center<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Coords>
where
    C: ConnectionTrait + 'async_trait,
{
    let center_txt = palitra_point::Entity::find()
        .select_only()
        .column_as(Expr::cust("ST_AsText(ST_Centroid(ST_Collect(ST_SetSRID(ST_MakePoint(lon, lat), 4326))))"), "geometric_average_wkt")
        .filter(palitra_point::Column::PalitraId.eq(palitra_id))
        .filter(palitra_point::Column::Deleted.eq(false))
        .group_by(palitra_point::Column::PalitraId)
        .into_tuple::<String>()
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())?;
    Coords::from_csv(&center_txt)
}

/// calculates outer perimeter for points in palitra
async fn calculate_convex_hull<'a, 'async_trait, C>(
    dbx: &'a C,
    palitra_id: i64,
) -> anyhow::Result<Vec<Coords>>
where
    C: ConnectionTrait + 'async_trait,
{
    #[derive(Debug, FromQueryResult)]
    pub struct Geometry {
        sequence_index: u16,
        lat: f64,
        lon: f64,
    }
    let query = r"
        SELECT
            -- dp.path is a 1-based index path array. We use [1] and subtract 1 for a 0-based sequence index.
            (dp.path[1] - 1) AS sequence_index,
            ST_X(dp.geom) AS lon,
            ST_Y(dp.geom) AS lat
        FROM
            (
                -- Subquery to calculate the outer perimeter polygon (Convex Hull)
                SELECT
                    -- 1. Get the exterior ring (a LineString) from the resulting polygon.
                    ST_ExteriorRing(
                        -- 2. Calculate the smallest convex polygon enclosing all collected points.
                        ST_ConvexHull(
                            -- 3. Collect all valid point geometries into a single geometry object.
                            ST_Collect(ST_SetSRID(ST_MakePoint(lon, lat), 4326))
                        )
                    ) AS hull_ring_linestring
                FROM
                    point
                WHERE
                    palitra_id = $1
                    AND deleted = FALSE
                -- The entire set of filtered points forms the input for the aggregate functions (ST_Collect, ST_ConvexHull)
            ) AS perimeter_data,
            -- Function to decompose the LineString back into individual point geometries with an index
            ST_DumpPoints(perimeter_data.hull_ring_linestring) AS dp
        ORDER BY  sequence_index;
    ";
    let mut convex_hull: Vec<Geometry> =
        Geometry::find_by_statement(Statement::from_sql_and_values(
            DbBackend::Postgres,
            query,
            [palitra_id.into()],
        ))
        .all(dbx)
        .await
        .context(h!())?;
    convex_hull.sort_by_key(|g| g.sequence_index);
    Ok(convex_hull
        .into_iter()
        .map(|c| Coords {
            lat: c.lat,
            lng: c.lon,
        })
        .collect())
}

pub async fn rewrite_palitra_points(
    palitra_id: i64,
    coords: Vec<PalitraPoint>,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let now = Utc::now().naive_utc();
    palitra::Entity::update_many()
        .filter(palitra::Column::Id.eq(palitra_id))
        .col_expr(palitra::Column::LastUploadedAt, Expr::value(now))
        .exec(txn)
        .await
        .c(h!())?;
    delete_existing_palitra_points(palitra_id, txn)
        .await
        .c(h!())?;
    let mut points = vec![];
    for point in coords {
        points.push(palitra_point::ActiveModel {
            id: NotSet,
            label: Set(point.label),
            palitra_id: Set(palitra_id),
            lat: Set(point.coords.lat),
            lng: Set(point.coords.lng),
            deleted: NotSet,
            deleted_at: NotSet,
            created_at: NotSet,
        });
    }
    palitra_point::Entity::insert_many(points)
        .exec(txn)
        .await
        .context(h!())?;
    recalculate_geometry(txn, palitra_id).await.c(h!())?;
    Ok(())
}

async fn delete_existing_palitra_points(
    palitra_id: i64,
    txn: &DatabaseTransaction,
) -> anyhow::Result<()> {
    let now = Utc::now().naive_utc();
    palitra_point::Entity::update_many()
        .filter(palitra_point::Column::PalitraId.eq(palitra_id))
        .filter(palitra_point::Column::Deleted.eq(false))
        .col_expr(palitra_point::Column::Deleted, Expr::value(true))
        .col_expr(palitra_point::Column::DeletedAt, Expr::value(now))
        .exec(txn)
        .await
        .context(h!())?;
    Ok(())
}

fn render_palitra(model: palitra::Model) -> anyhow::Result<Palitra> {
    let last_uploaded_at_ts = model
        .last_uploaded_at
        .map(|ts| ts.and_utc().timestamp_millis());
    let geometry = match model.geometry {
        Some(geometry) => Some(serde_json::from_value(geometry).c(h!())?),
        None => None,
    };
    Ok(Palitra {
        id: model.id,
        name: model.name,
        color_hex: model.hex,
        aor_id: model.area_of_responsibility_id,
        owner_organism_id: model.owner_organism_id,
        owner_login: model.owner_login,
        source_file_name: model.source_file_name,
        last_uploaded_at_ts,
        geometry,
    })
}

async fn collect_palitras(
    login: String,
    dbx: &DatabaseConnection,
) -> anyhow::Result<Vec<palitra::Model>> {
    let mut organism_filter = palitra::Column::OwnerOrganismId.is_null();
    let organism_id = login::Entity::find_by_id(login.clone())
        .one(dbx)
        .await
        .c(h!())?
        .c(h!())?
        .organism_id;
    if let Some(organism_id) = organism_id {
        organism_filter = organism_filter
            .or(palitra::Column::OwnerOrganismId.eq(organism_id));
    }
    let login_filter = palitra::Column::OwnerLogin
        .is_null()
        .or(palitra::Column::OwnerLogin.eq(login));
    let palitra_models = palitra::Entity::find()
        .filter(organism_filter)
        .filter(login_filter)
        .filter(palitra::Column::Deleted.eq(false))
        .all(dbx)
        .await
        .c(h!())?;
    Ok(palitra_models)
}

fn update_palitra_from_req(
    req: CreatePalitraReq,
    palitra_val: palitra::ActiveModel,
) -> palitra::ActiveModel {
    let mut palitra = palitra_val;
    palitra.name = Set(req.name);
    palitra.hex = Set(req.color_hex);
    palitra.area_of_responsibility_id = Set(req.aor_id);
    palitra.owner_organism_id = Set(req.owner_organism_id);
    palitra.owner_login = Set(req.owner_login);
    palitra
}
