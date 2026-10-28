const FIXTURE: &str = r#"
set statement_timeout='30s';
create temp table ai_settlement_worker_job (sigint_inbox_item_id bigint primary key, created_at timestamp not null);
create index on ai_settlement_worker_job(created_at);
create temp table signal_message_group (signal_message_id bigint,group_master_key text);
create index on signal_message_group(signal_message_id,group_master_key);
create index on signal_message_group(group_master_key,signal_message_id);
insert into ai_settlement_worker_job select n,'2026-10-01'::timestamp+n*interval '1 second' from generate_series(1,2000000) n;
insert into signal_message_group select n,case when n<=1999000 then 'excluded' else 'included' end from generate_series(1,2000000) n;
analyze ai_settlement_worker_job;
analyze signal_message_group;
explain (analyze,buffers,timing off,summary on) select created_at from ai_settlement_worker_job order by created_at limit 1;
explain (analyze,buffers,timing off,summary on) select created_at from ai_settlement_worker_job q where exists(select 1 from signal_message_group g where g.signal_message_id=q.sigint_inbox_item_id and g.group_master_key='included') order by created_at limit 1;
explain (analyze,buffers,timing off,summary on) select created_at from ai_settlement_worker_job q where not exists(select 1 from signal_message_group g where g.signal_message_id=q.sigint_inbox_item_id and g.group_master_key='excluded') order by created_at limit 1;
explain (analyze,buffers,timing off,summary on) select created_at from ai_settlement_worker_job q where exists(select 1 from signal_message_group g where g.signal_message_id=q.sigint_inbox_item_id and g.group_master_key='missing') order by created_at limit 1;
"#;
