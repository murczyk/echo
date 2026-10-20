use crate::file_registry::test_support::ARCHIVE_PUBLICATION_SQL;
use sea_orm::{ConnectionTrait, DatabaseConnection};
use uuid::Uuid;

pub(in crate::devices::files) async fn publish(
    db: &DatabaseConnection,
    device: Uuid,
    file: Uuid,
    revision: i64,
    names: [&str; 2],
) -> Uuid {
    let archive = super::enqueue::ensure(db, device, file, revision)
        .await
        .unwrap()
        .unwrap();
    for name in names {
        assert!(!name.contains('\''));
    }
    db.execute_unprepared(
        &ARCHIVE_PUBLICATION_SQL
            .replace(
                "00000000-0000-0000-0000-000000000101",
                &archive.to_string(),
            )
            .replace("Report.txt", names[0])
            .replace("report.txt", names[1]),
    )
    .await
    .unwrap();
    archive
}
