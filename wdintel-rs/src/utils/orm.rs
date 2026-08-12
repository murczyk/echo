use echo_migration::{Expr, SimpleExpr};
use sea_orm::{ColumnTrait, DeriveIden, IntoSimpleExpr, Value};

#[derive(DeriveIden)]
#[sea_orm(iden = "CONCAT")]
pub struct Concat;

/// Array comparison operations, can be extended with lt (<), gte (>=), etc..
pub trait ArrayColumnOps
where
    Self: ColumnTrait,
{
    fn ne_any<V>(&self, v: Vec<V>) -> SimpleExpr
    where
        Vec<V>: Into<Value>;

    fn eq_all<V>(&self, v: Vec<V>) -> SimpleExpr
    where
        Vec<V>: Into<Value>;
}

impl<T> ArrayColumnOps for T
where
    T: ColumnTrait,
{
    fn ne_any<V>(&self, v: Vec<V>) -> SimpleExpr
    where
        Vec<V>: Into<Value>,
    {
        any_all_impl(self, "<>", "ANY", v)
    }

    fn eq_all<V>(&self, v: Vec<V>) -> SimpleExpr
    where
        Vec<V>: Into<Value>,
    {
        any_all_impl(self, "=", "ALL", v)
    }
}

fn any_all_impl<T, V>(col: &T, op: &str, func: &str, v: Vec<V>) -> SimpleExpr
where
    T: ColumnTrait,
    Vec<V>: Into<Value>,
{
    Expr::cust_with_exprs(
        format!("$1 {op} {func}($2)"),
        [
            Expr::col((col.entity_name(), *col)).into_simple_expr(),
            Expr::val(v).into_simple_expr(),
        ],
    )
}
