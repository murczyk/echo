use sea_orm::DeriveIden;

#[derive(DeriveIden)]
#[sea_orm(iden = "CONCAT")]
pub struct Concat;
