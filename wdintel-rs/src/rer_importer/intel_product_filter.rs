use super::sea_orm_active_enums::IntelProductRelationKind;
use crate::entities::intel_product;
use sea_orm::prelude::*;
use sea_orm::sea_query::{Alias, Expr, SimpleExpr};
use sea_orm::ExprTrait;

pub const RELATION_KIND_REPORT: IntelProductRelationKind =
    IntelProductRelationKind::Report;
pub const RELATION_KIND_COMMENT: IntelProductRelationKind =
    IntelProductRelationKind::Comment;

/// Uses string literals so PostgreSQL infers the enum while the analytics
/// gateway can parse the same SQL without knowing PostgreSQL enum types.
pub fn relation_kind_is_in<I>(relation_kinds: I) -> SimpleExpr
where
    I: IntoIterator<Item = IntelProductRelationKind>,
{
    Expr::col((intel_product::Entity, intel_product::Column::RelationKind))
        .cast_as(Alias::new("text"))
        .is_in(relation_kinds.into_iter().map(|kind| kind.to_value()))
}

pub fn relation_kind_eq(relation_kind: IntelProductRelationKind) -> SimpleExpr {
    Expr::col((intel_product::Entity, intel_product::Column::RelationKind))
        .cast_as(Alias::new("text"))
        .eq(relation_kind.to_value())
}
