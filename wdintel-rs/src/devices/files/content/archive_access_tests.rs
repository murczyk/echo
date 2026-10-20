use super::*;
use crate::devices::files::{archive::access, content::read};
use crate::file_registry::test_support::ARCHIVE_PUBLICATION_SQL;

#[actix_web::test]
#[serial_test::serial]
async fn derived_content_requires_ready_archive_exact_revision_and_current_access(
) {
    let (env, _guard) = cleanup_locked().await.unwrap();
    let fixture = Fixture::new(&env).await;
    let source = fixture
        .file_with_metadata("archive.zip", "application/zip", "zip")
        .await;
    crate::file_registry::test_support::publish_content(
        fixture.db(),
        &source,
        fixture.login.id,
    )
    .await;
    let tx = fixture.db().begin().await.unwrap();
    tx.execute_raw(sea_orm::Statement::from_sql_and_values(sea_orm::DbBackend::Postgres,
        "insert into file_archive(id,device_id,source_file_id,source_revision,source_object_key,source_sha256,source_size_bytes,source_is_encrypted,root_id,depth,policy) select '00000000-0000-0000-0000-000000000101',r.device_id,r.id,r.revision,c.object_key,c.source_sha256,c.source_size_bytes,c.is_encrypted,'00000000-0000-0000-0000-000000000101',1,'{}' from file_revision r join file_content c on c.file_id=r.id and c.revision=r.revision where r.id=$1",
        [source.id.into()])).await.unwrap();
    let publication = ARCHIVE_PUBLICATION_SQL.replace(
        "update file_archive set state='ready',heartbeat_at=null where id=archive;",
        "",
    );
    tx.execute_unprepared(&publication).await.unwrap();
    let member = tx
        .query_one_raw(sea_orm::Statement::from_string(
            sea_orm::DbBackend::Postgres,
            "select id as file_id from file_revision where origin_archive_id is not null order by archive_member_index limit 1"
                .to_owned(),
        ))
        .await
        .unwrap()
        .unwrap()
        .try_get::<Uuid>("", "file_id")
        .unwrap();
    assert!(
        access::find_published_content(&tx, fixture.device.id, member, 1)
            .await
            .unwrap()
            .is_none()
    );
    assert!(access::find_published_content(
        &tx,
        fixture.device.id,
        source.id,
        1
    )
    .await
    .unwrap()
    .is_some());
    tx.execute_unprepared(
        "update file_archive set state='ready',heartbeat_at=null",
    )
    .await
    .unwrap();
    let published =
        access::find_published_content(&tx, fixture.device.id, member, 1)
            .await
            .unwrap()
            .unwrap();
    assert_eq!(published.name, "Report.txt");
    assert_eq!(published.source_size_bytes, 1);
    for (device, revision) in [(Uuid::new_v4(), 1), (fixture.device.id, 2)] {
        assert!(
            access::find_published_content(&tx, device, member, revision)
                .await
                .unwrap()
                .is_none()
        );
    }
    tx.commit().await.unwrap();
    let target = (fixture.device.id, member, 1);
    let content = read::load_published_content(
        &env,
        &fixture.login,
        target.0,
        target.1,
        target.2,
    )
    .await
    .unwrap();
    assert_eq!(content.object_key, published.object_key);
    let prepared = read::prepare_authorized_content(
        &env,
        fixture.login.id,
        target,
        &content,
        async {
            env.dbx
                .execute_raw(sea_orm::Statement::from_sql_and_values(
                    sea_orm::DbBackend::Postgres,
                    "update login set roles='[]'::jsonb where id=$1",
                    [fixture.login.id.into()],
                ))
                .await
                .unwrap();
            Ok(b"private prepared bytes".to_vec())
        },
    )
    .await;
    assert!(
        prepared.is_err(),
        "revocation during preparation must withhold prepared bytes"
    );
}
