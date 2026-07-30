use sea_orm::prelude::Expr;
use sea_orm::sea_query::SimpleExpr;

pub(crate) fn goi_network_visible_for_organism(organism_id: i64) -> SimpleExpr {
    Expr::cust_with_values(
        r#"
        EXISTS (
            SELECT 1
            FROM organism_aor
            JOIN area_of_responsibility selected_aor
                ON selected_aor.id = organism_aor.aor_id
            WHERE organism_aor.organism_id = $1
              AND selected_aor.deleted = false
              AND EXISTS (
                  SELECT 1
                  FROM sigint_network_aor
                  JOIN area_of_responsibility linked_aor
                      ON linked_aor.id = sigint_network_aor.aor_id
                  WHERE sigint_network_aor.network_id = sigint_network.id
                    AND linked_aor.deleted = false
                    AND (
                        linked_aor.left_bound BETWEEN selected_aor.left_bound
                            AND selected_aor.right_bound
                        OR (
                            linked_aor.left_bound <= selected_aor.left_bound
                            AND linked_aor.right_bound >= selected_aor.right_bound
                        )
                    )
              )
        )
        "#,
        vec![organism_id],
    )
}

pub(crate) fn goi_joined_aor_visible_for_organism(
    organism_id: i64,
) -> SimpleExpr {
    Expr::cust_with_values(
        r#"
        EXISTS (
            SELECT 1
            FROM organism_aor
            JOIN area_of_responsibility selected_aor
                ON selected_aor.id = organism_aor.aor_id
            WHERE organism_aor.organism_id = $1
              AND selected_aor.deleted = false
              AND (
                  area_of_responsibility.left_bound BETWEEN selected_aor.left_bound
                      AND selected_aor.right_bound
                  OR (
                      area_of_responsibility.left_bound <= selected_aor.left_bound
                      AND area_of_responsibility.right_bound >= selected_aor.right_bound
                  )
              )
        )
        "#,
        vec![organism_id],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entities::{area_of_responsibility, sigint_network};
    use sea_orm::{DbBackend, EntityTrait, QueryFilter, QueryTrait};

    #[test]
    fn network_visibility_filters_by_organism_aor_bounds() {
        let sql = sigint_network::Entity::find()
            .filter(goi_network_visible_for_organism(42))
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains("FROM organism_aor"));
        assert!(sql.contains("organism_aor.organism_id = 42"));
        assert!(sql.contains("FROM sigint_network_aor"));
        assert!(
            sql.contains("sigint_network_aor.network_id = sigint_network.id")
        );
        assert!(sql
            .contains("linked_aor.left_bound BETWEEN selected_aor.left_bound"));
    }

    #[test]
    fn joined_aor_visibility_filters_current_aor_by_organism_bounds() {
        let sql = area_of_responsibility::Entity::find()
            .filter(goi_joined_aor_visible_for_organism(42))
            .build(DbBackend::Postgres)
            .to_string();

        assert!(sql.contains("FROM organism_aor"));
        assert!(sql.contains("organism_aor.organism_id = 42"));
        assert!(sql.contains(
            "area_of_responsibility.left_bound BETWEEN selected_aor.left_bound"
        ));
    }
}
