use super::*;

#[tokio::test]
#[serial_test::serial]
async fn device_document_positions_use_current_aor_and_isolate_private_groups_3064(
) {
    use crate::{
        ai_position::types::{
            AiPositionLookupKnown, AiPositionLookupReq, AiPositionLookupRsp,
        },
        entities::{area_of_responsibility, device_aor},
        functest::tests::mk_aor,
    };
    let (env, _guard) = cleanup_locked().await.unwrap();
    system_settings::ActiveModel {
        devices_section_enabled: Set(true),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let human = reader(&env).await;
    let visible = device(&env, &human).await;
    let _file = file(&env, visible.id, "position.txt", true, human.id).await;
    let aor = mk_aor(&env.dbx, Default::default()).await.unwrap();
    let assignment = device_aor::ActiveModel {
        id: Set(Uuid::now_v7()),
        device_id: Set(visible.id),
        aor_id: Set(aor.id),
        ..Default::default()
    }
    .insert(&env.dbx)
    .await
    .unwrap();
    let job = queue::claim(&env, "extract").await.unwrap().unwrap();
    extraction::publish(&env, &job, package("Циркон 9 36T XT 75734 68963"))
        .await
        .unwrap();
    let db = env.file_registry_db().unwrap().connection();
    execute(db,"insert into file_document_position(id,chunk_id,name,name_key,kind,spans,coordinates) select $1,id,'Циркон 9','циркон 9','position',$3,$4 from file_document_chunk where generation=$2",vec![Uuid::now_v7().into(),job.generation.into(),json!([{"begin":0,"end":8}]).into(),json!([{"text":"36T XT 75734 68963","system":"mgrs","mgrs":"36TXT7573468963","lat":47.55,"lng":35.335,"certainty":"high","evidence":"Циркон 9","span":null}]).into()]).await.unwrap();
    let req = AiPositionLookupReq {
        name: Some("ЦИРКОН-9".into()),
        coordinates: None,
        radius_meters: None,
        days: Some(1),
        kind: None,
        limit: None,
    };
    let files = super::super::positions::lookup(&env, human.id, &req)
        .await
        .unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].aor_ids, vec![aor.id]);
    assert_eq!(files[0].observation_at, None);
    let known = AiPositionLookupKnown {
        name: "Циркон 9".into(),
        kind: "position".into(),
        mgrs: "36TXT7573468963".into(),
        lat: 48.0,
        lng: 35.0,
        certainty: "high".into(),
        conflicting: false,
        fact_count: 1,
        first_fact_at: "2025-01-01".into(),
        last_fact_at: "2025-01-01".into(),
        scope: "РВ".into(),
        scope_kind: "aor".into(),
        scope_key: aor.id.to_string(),
    };
    let mut private = known.clone();
    private.scope_kind = "group".into();
    private.scope_key = "private".into();
    let response = AiPositionLookupRsp {
        known: vec![known, private],
        file_mentions: files,
        evidence_groups: vec![],
        located: vec![],
        other: vec![],
        note: String::new(),
    };
    let groups = super::super::evidence::group(&response);
    assert_eq!(groups.len(), 2);
    let shared = groups.iter().find(|g| g.scope_kind == "aor").unwrap();
    assert_eq!(shared.known_indexes, vec![0]);
    assert_eq!(shared.file_indexes, vec![0]);
    assert!(shared.conflicting);
    assert_eq!(shared.certainty, "low");
    assert!(groups
        .iter()
        .find(|g| g.scope_kind == "group")
        .unwrap()
        .file_indexes
        .is_empty());
    let next = mk_aor(
        &env.dbx,
        area_of_responsibility::ActiveModel {
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let mut assignment = assignment.into_active_model();
    assignment.aor_id = Set(next.id);
    assignment.update(&env.dbx).await.unwrap();
    assert_eq!(
        super::super::positions::lookup(&env, human.id, &req)
            .await
            .unwrap()[0]
            .aor_ids,
        vec![next.id]
    );
    let foreign = reader(&env).await;
    assert!(super::super::positions::lookup(&env, foreign.id, &req)
        .await
        .unwrap()
        .is_empty());
}
