use super::*;

pub(super) async fn fill_missing_upper_echelons<C>(
    dbx: &C,
    req: &mut CreateUnitReq,
) -> anyhow::Result<()>
where
    C: ConnectionTrait,
{
    if !req.military_district.trim().is_empty()
        && !req.army_region.trim().is_empty()
    {
        return Ok(());
    }
    let hierarchy = unit_req_hierarchy(req);
    let Some(level) =
        hierarchy.iter().position(|value| !value.trim().is_empty())
    else {
        return Ok(());
    };
    if level > crate::orbit::EchoEchelon::Army.index() {
        return Ok(());
    }
    let Some((military_district, army_region)) =
        find_reference_upper_echelons(dbx, hierarchy, level)
            .await
            .c(h!())?
    else {
        return Ok(());
    };
    if req.military_district.trim().is_empty() {
        req.military_district = military_district;
    }
    if req.army_region.trim().is_empty() {
        req.army_region = army_region;
    }
    Ok(())
}

async fn find_reference_upper_echelons<C>(
    dbx: &C,
    hierarchy: [&str; 14],
    level: usize,
) -> anyhow::Result<Option<(String, String)>>
where
    C: ConnectionTrait,
{
    let columns = [
        sigint_unit::Column::Other,
        sigint_unit::Column::TeamOrCrew,
        sigint_unit::Column::Section,
        sigint_unit::Column::Squad,
        sigint_unit::Column::Platoon,
        sigint_unit::Column::Company,
        sigint_unit::Column::Battalion,
        sigint_unit::Column::Regiment,
        sigint_unit::Column::Brigade,
        sigint_unit::Column::Division,
        sigint_unit::Column::Corps,
        sigint_unit::Column::Army,
    ];
    let mut query = sigint_unit::Entity::find()
        .select_only()
        .columns([
            sigint_unit::Column::MilitaryDistrict,
            sigint_unit::Column::ArmyRegion,
        ])
        .filter(sigint_unit::Column::Deleted.eq(false));
    for (index, column) in columns.into_iter().enumerate().take(level + 1) {
        query = query.filter(Expr::cust_with_exprs(
            "lower(btrim($1)) = $2",
            [
                Expr::col(column).into_simple_expr(),
                Expr::val(hierarchy[index].trim().to_lowercase())
                    .into_simple_expr(),
            ],
        ));
    }
    query
        .order_by_asc(sigint_unit::Column::Id)
        .into_tuple::<(String, String)>()
        .one(dbx)
        .await
        .c(h!())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::functest::tests::{cleanup_locked, mk_sigint_unit};
    use serial_test::serial;

    #[tokio::test]
    #[serial]
    async fn issue_3527_creation_inherits_from_inactive_lowest_echelon() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        for (deleted, company) in [(true, ""), (false, "1 рота")] {
            mk_sigint_unit(
                &env.dbx,
                sigint_unit::ActiveModel {
                    brigade: Set("3527 омсбр".to_string()),
                    company: Set(company.to_string()),
                    deleted: Set(deleted),
                    military_district: Set("Інший фронт".to_string()),
                    army_region: Set("Інший регіон".to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        let reference = mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                brigade: Set(" 3527 ОМСБР ".to_string()),
                military_district: Set("Група армій".to_string()),
                army_region: Set("Регіон".to_string()),
                active: Set(false),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let (unit, _) = create_unit_for_login(
            &login,
            &env,
            CreateUnitReq {
                brigade: "3527 омсбр".to_string(),
                army: "20 А".to_string(),
                active: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(unit.military_district, "Група армій");
        assert_eq!(unit.army_region, "Регіон");
        assert_eq!(unit.army, "20 А");
        assert!(unit.company.is_empty());
        assert!(
            !sigint_unit::Entity::find_by_id(reference.id)
                .one(&env.dbx)
                .await
                .unwrap()
                .unwrap()
                .active
        );
        let changelog = sigint_unit_changelog::Entity::find()
            .filter(sigint_unit_changelog::Column::SigintUnitId.eq(unit.id))
            .filter(sigint_unit_changelog::Column::Action.eq("create"))
            .one(&env.dbx)
            .await
            .unwrap()
            .unwrap();
        let created = changelog.new_value.unwrap();
        assert_eq!(created["military_district"], "Група армій");
        assert_eq!(created["army_region"], "Регіон");
    }

    #[tokio::test]
    #[serial]
    async fn issue_3527_auto_network_creation_preserves_upper_echelons() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        super::super::tests::insert_settings(&env.dbx, true).await;
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                army: Set("3527 А".to_string()),
                military_district: Set("Група армій".to_string()),
                army_region: Set("Регіон".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for (
            military_district,
            army_region,
            expected_district,
            expected_region,
        ) in [
            ("Свій фронт", "  ", "Свій фронт", "Регіон"),
            ("", "Свій регіон", "Група армій", "Свій регіон"),
            ("Свій фронт", "Свій регіон", "Свій фронт", "Свій регіон"),
        ] {
            let response = create_unit_with_auto_network_for_login(
                &login,
                &env,
                CreateUnitWithAutoNetworkReq {
                    unit: CreateUnitReq {
                        army: "3527 А".to_string(),
                        military_district: military_district.to_string(),
                        army_region: army_region.to_string(),
                        ..Default::default()
                    },
                    skip_network_creation: true,
                    locations: vec![],
                    unit_mask: vec![],
                },
            )
            .await
            .unwrap();
            assert_eq!(response.unit.military_district, expected_district);
            assert_eq!(response.unit.army_region, expected_region);
        }
    }

    #[tokio::test]
    #[serial]
    async fn issue_3527_creation_requires_a_matching_lowest_echelon() {
        let (env, _guard) = cleanup_locked().await.unwrap();
        let login = crate::users::login_id_by_name(&env.dbx, "Tester")
            .await
            .unwrap();
        for (army, company, deleted) in
            [("3527 А", "1 рота", false), ("Видалена А", "", true)]
        {
            mk_sigint_unit(
                &env.dbx,
                sigint_unit::ActiveModel {
                    army: Set(army.to_string()),
                    company: Set(company.to_string()),
                    military_district: Set("Група армій".to_string()),
                    army_region: Set("Регіон".to_string()),
                    deleted: Set(deleted),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        }
        mk_sigint_unit(
            &env.dbx,
            sigint_unit::ActiveModel {
                military_district: Set("Група армій".to_string()),
                army_region: Set("Регіон".to_string()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for req in [
            CreateUnitReq {
                army: "3527 А".to_string(),
                ..Default::default()
            },
            CreateUnitReq {
                army: "Видалена А".to_string(),
                ..Default::default()
            },
            CreateUnitReq {
                battalion: "Невідомий батальйон".to_string(),
                army: "3527 А".to_string(),
                ..Default::default()
            },
            CreateUnitReq {
                military_district: "Група армій".to_string(),
                ..Default::default()
            },
            CreateUnitReq {
                name: Some("Лише назва".to_string()),
                ..Default::default()
            },
        ] {
            let (unit, _) = create_unit_for_login(&login, &env, req.clone())
                .await
                .unwrap();
            assert_eq!(unit.military_district, req.military_district);
            assert_eq!(unit.army_region, req.army_region);
        }
    }
}
