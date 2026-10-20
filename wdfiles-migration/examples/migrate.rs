use sea_orm::Database;
use wdfiles_migration::{Migrator, MigratorTrait};

#[tokio::main]
async fn main() {
    let db = Database::connect(std::env::var("DATABASE_URL").unwrap())
        .await
        .unwrap();
    if std::env::args().nth(1).as_deref() == Some("down") {
        Migrator::down(&db, Some(1)).await.unwrap();
    } else {
        Migrator::up(&db, None).await.unwrap();
    }
}
