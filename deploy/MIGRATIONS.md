# Migrations

## Initial setup of PostgreSQL

```
ALTER SYSTEM SET max_connections TO '500';
alter system set idle_in_transaction_session_timeout='5min';
```

## 2022-01-01

```sql
-- DROP TABLE public.delta_kv;
CREATE TABLE public.delta_kv (
	id BIGSERIAL PRIMARY KEY,
	k varchar(200) NOT NULL,
	v jsonb NOT NULL,
	CONSTRAINT delta_kv_un UNIQUE (k)
);

-- DROP TABLE public.bgtask;
CREATE TABLE public.bgtask (
	id BIGSERIAL PRIMARY KEY,
	progress int8 not null, -- 0 to 100
	loglines jsonb NOT NULL,
	running BOOLEAN NOT NULL,
	finished_with_error TEXT
);
```

## 2022-01-04

```sql
-- DROP TABLE public.restream;
CREATE TABLE public.restream (
	id BIGSERIAL PRIMARY KEY,
	process_id int8 not null,
	source_id text,
	source_title text,
	source_url text not null,
	sink_url text not null,
	created_at timestamp without time zone default (now() at time zone 'utc') not null
);
```

## 2022-01-06

```sql
-- DROP TABLE public.url_visit_notification;
CREATE TABLE public.url_visit_notification (
	id BIGSERIAL PRIMARY KEY,
	visit_url text not null,
	client_id text not null,
	created_at timestamp without time zone default (now() at time zone 'utc') not null
);
```

## 2023-01-15

```sql
-- DROP TABLE public.signal_message;
CREATE TABLE public.signal_message (
	id BIGSERIAL PRIMARY KEY,
	body text,
	created_at timestamp without time zone default (now() at time zone 'utc') not null
);

-- DROP TABLE public.signal_attachment;
CREATE TABLE public.signal_attachment (
	id BIGSERIAL PRIMARY KEY,
	signal_message_id int8 REFERENCES signal_message (id) not null,
	path text not null,
	created_at timestamp without time zone default (now() at time zone 'utc') not null,
	CONSTRAINT fk_signal_attachment_signal_message FOREIGN KEY (signal_message_id) REFERENCES signal_message (id)
);
```

## 2023-02-07

```sql
ALTER TABLE restream ADD COLUMN google_client_id TEXT;
```

## 2023-02-10

```sql
CREATE INDEX signal_message_created_at_idx ON signal_message ((created_at::TIMESTAMP));
```

## 2023-02-12

```sql
alter table restream add column user_id text not null;
alter table url_visit_notification add column user_id text not null;
```

## 2023-02-15

```sql
-- drop table sigint_inbox_item;
CREATE TABLE public.sigint_inbox_item (
	id int8 PRIMARY KEY REFERENCES signal_message (id),
	date text,
	time text,
	freq text,
	coords text,
	callsigns jsonb,
	checked boolean
);
```

## 2023-02-16

```sql
ALTER TABLE public.signal_message ADD COLUMN group_master_key text;
ALTER TABLE public.signal_message ADD COLUMN timestamp TIMESTAMP;
```

## 2023-02-19

```sql
-- drop table callsign_lexeme;
CREATE TABLE public.callsign_lexeme (
	id BIGSERIAL PRIMARY KEY,
	callsign text not null,
	lexeme text not null
);
create index callsign_lexeme_idx  on callsign_lexeme ((lexeme::text));
```

## 2023-02-26

```sql
-- drop table network_callsign;
create table network_callsign (
	id BIGSERIAL PRIMARY KEY,
	callsign text not null,
	freq text not null
);
create index network_callsign_callsign_idx  on network_callsign ((callsign::text));
```

## 2023-03-02

```sql
-- drop table bgtask_res;
create table bgtask_res (
	id int8 PRIMARY KEY REFERENCES bgtask (id),
	res_json jsonb,
	res_bytes bytea
);
```

## 2023-03-29

```
-- drop table signal_group;
create table signal_group (
	master_key text PRIMARY KEY,
	name text
);

-- drop table signal_profile;
create table signal_profile (
	uuid text PRIMARY KEY,
	given_name text,
	family_name text
);

ALTER TABLE public.signal_message ADD COLUMN sender text;
```

## 2023-03-31

```
ALTER TABLE public.signal_message ADD COLUMN duplicate_of int8;
```

```
CREATE INDEX signal_message_duplicate_of_idx ON signal_message ((duplicate_of::int8));
```

## 2023-04-05

```
ALTER TABLE public.sigint_inbox_item ADD COLUMN reviewed bool;
-- stop sigint worker before doing this
UPDATE sigint_inbox_item SET reviewed=true;
```

## 2023-04-06

```
ALTER TABLE public.sigint_inbox_item ADD COLUMN extended_form text;
```

## 2023-04-10

```
ALTER TABLE public.sigint_inbox_item ADD COLUMN unit text;
```

## 2023-04-14

```
-- drop table sigint_bookmark;
create table sigint_bookmark (
	id BIGSERIAL PRIMARY KEY,
	user_id text not null,
	signal_message_id int8 REFERENCES signal_message (id) not null,
	created_at timestamp without time zone default (now() at time zone 'utc') not null
);

CREATE INDEX sigint_bookmark_signal_message_id_idx ON sigint_bookmark ((signal_message_id::int8));
CREATE INDEX sigint_bookmark_created_at_idx ON sigint_bookmark ((created_at::TIMESTAMP));
```

```
ALTER TABLE public.sigint_inbox_item ADD COLUMN callsign_tokens jsonb;
```

## 2023-04-20

```
ALTER TABLE public.sigint_inbox_item ADD COLUMN keyword_tokens jsonb;
```

## 2023-04-24

```
-- drop table freeair_poi;
CREATE TABLE freeair_poi (
	id BIGSERIAL PRIMARY KEY,
	feature jsonb not null,
	poi_id text not null,
	poi_lat double precision not null,
	poi_lng double precision not null,
	poi_type text not null,
	created_at timestamp without time zone default (now() at time zone 'utc') not null,
	last_timestamp_utc timestamp without time zone not null
);
```

```sql
CREATE INDEX freeair_poi_last_timestamp_utc_idx ON freeair_poi ((last_timestamp_utc::TIMESTAMP));
ALTER TABLE freeair_poi ADD COLUMN nominatim_res jsonb;
ALTER TABLE freeair_poi ADD COLUMN nominatim_display_name text;
```

## 2023-05-01

```sql
-- drop table freeair_tracksn
CREATE TABLE freeair_tracksn (
	id BIGSERIAL PRIMARY KEY,
	sn text not null
);

-- drop table freeair_tracksn
CREATE TABLE alert (
	id BIGSERIAL PRIMARY KEY,
	created_at timestamp without time zone default (now() at time zone 'utc') not null,
	sent bool not null,
	alert text not null
);
CREATE INDEX alert_idx ON alert ((created_at::TIMESTAMP));
```

## 2023-05-16

```
ALTER TABLE public.signal_message ADD COLUMN format int8;
```

## 2023-05-18

```
UPDATE signal_message SET group_master_key='RiJ94m7SWDJCtzxsxiZjYE5MdPhfw5BrH2cPewq9YkQ=' where group_master_key='n0vaarNf4BoYNPiX7hQH87ys3xsSDva3FX3R3Dhi5rU';
UPDATE signal_message SET group_master_key='2B+qXetut3069kbyy57NCwCiUpcUMGXG7lzs6aKtbXM=' where group_master_key='aznGehmbrUXDoEAFftPQUXlV/ryrwIq009Uqg0c268I';
UPDATE signal_message SET group_master_key='HI63xH3Ooo+VuxvNRZ5SFCiW+S7Nmpi+xzRoOHZ1TWg=' where group_master_key='8VfGizN8lkbuUXG8H8gw27J+fWA73jQzLJPK0Fh/bFs';
```

## 2023-05-19

```
ALTER TABLE public.sigint_inbox_item ADD COLUMN lat double precision;
ALTER TABLE public.sigint_inbox_item ADD COLUMN lng double precision;
update sigint_inbox_item set coords=null where id=28398;
update sigint_inbox_item set coords=null where id=28373;
```

## 2023-05-20

```
CREATE TABLE nominatimres (
	id BIGSERIAL PRIMARY KEY,
	created_at timestamp without time zone default (now() at time zone 'utc') not null,
	res jsonb not null,
	nominatim_display_name text not null
);

ALTER TABLE sigint_inbox_item ADD COLUMN nominatimres_id int8 REFERENCES nominatimres (id);
```

## 2023-05-23

```
CREATE TABLE signal_restapi_error (
	id BIGSERIAL PRIMARY KEY,
	created_at timestamp without time zone default (now() at time zone 'utc') not null,
	res_txt text not null,
	res jsonb
);
CREATE INDEX signal_restapi_error_idx ON signal_restapi_error ((created_at::TIMESTAMP));
```

## 2023-05-31

```
CREATE TABLE sigint_saved_filter (
	id BIGSERIAL PRIMARY KEY,
	created_at timestamp without time zone default (now() at time zone 'utc') not null,
	name text not null,
	req jsonb not null
);
```

## 2023-06-02

```
ALTER DATABASE wd SET default_text_search_config TO 'pg_catalog.russian';
```

## 2023-06-05

```
CREATE TABLE sigint_search (
	id BIGSERIAL PRIMARY KEY,
    search_tsv tsvector
);

CREATE INDEX sigint_search_tsv_idx ON sigint_search USING GIN (search_tsv);

ALTER TABLE sigint_search ADD CONSTRAINT fk_sigint_search_id FOREIGN KEY (id) REFERENCES signal_message(id);
```

## 2023-06-08

```
ALTER TABLE restream ADD COLUMN restreamer_host text;
```

## 2023-06-13

```
CREATE TABLE login (
	login TEXT NOT NULL PRIMARY KEY,
	password TEXT NOT NULL,
	roles jsonb NOT NULL,
	created_at timestamp without time zone default (now() at time zone 'utc') not null
);
```

## 2023-06-14

```
CREATE TABLE datasource (
	id BIGSERIAL PRIMARY KEY,
	kind TEXT NOT NULL,
	display_name TEXT NOT NULL,
	signal_phone TEXT,
	signal_docker_port TEXT,
	api_endpoint TEXT,
	enabled boolean
);

insert into datasource values (1, 'signal', 'Signal ‭+380992761275‬ Sc0rpi0n', '+380992761275‬', '8083', null, true);
insert into datasource values (2, 'api', 'API Сергій Буран', null, null, 'https://185.156.42.67:3000', false);

alter table signal_group add column datasource_id int8 REFERENCES datasource (id);

update signal_group set datasource_id=1;

CREATE TABLE sigint_zone (
	id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
	created_at timestamp without time zone default (now() at time zone 'utc') not null
);

INSERT INTO sigint_zone (id, name) VALUES (1, 'Запоріжжя');
INSERT INTO sigint_zone (id, name) VALUES (2, 'Авдіївка');
```

## 2023-06-15

```
CREATE TABLE sigint_zone_datasource (
	id BIGSERIAL PRIMARY KEY,
	sigint_zone_id int8 REFERENCES sigint_zone (id) not null,
	datasource_id int8 REFERENCES datasource (id) not null,
	group_master_keys jsonb,
	created_at timestamp without time zone default (now() at time zone 'utc') not null
);
insert into sigint_zone_datasource (id, sigint_zone_id, datasource_id) values (1, 1, 1);
insert into sigint_zone_datasource (id, sigint_zone_id, datasource_id) values (2, 2, 2);

ALTER TABLE signal_message ADD COLUMN datasource_id int8 REFERENCES datasource (id);

-- after deploy
update signal_message set datasource_id=1;
```

## 2023-06-16

```
alter table login add column sigint_zone_id int8  REFERENCES sigint_zone (id);
update login set sigint_zone_id=1 where login='wd';
update login set sigint_zone_id=1 where login='rer';
update login set sigint_zone_id=1 where login='ziggy';

alter table datasource add column group_master_key text;
update datasource set group_master_key='3b43d8f8-45d0-46d0-893c-86ff2da246d8' where id=2;
update sigint_zone_datasource set group_master_keys='["3b43d8f8-45d0-46d0-893c-86ff2da246d8"]' where id=2;
insert into signal_group (master_key, name, datasource_id) values ('3b43d8f8-45d0-46d0-893c-86ff2da246d8', 'API Сергій Буран', 2);
```

## 2023-06-17

```
alter table sigint_inbox_item add column location text;

update datasource set group_master_key='ffffffff-45d0-46d0-893c-86ff2da246d8' where id=2;
update sigint_zone_datasource set group_master_keys='["ffffffff-45d0-46d0-893c-86ff2da246d8"]' where id=2;
update signal_group set master_key='ffffffff-45d0-46d0-893c-86ff2da246d8' where master_key='3b43d8f8-45d0-46d0-893c-86ff2da246d8';

insert into signal_profile (uuid, given_name, family_name) values ('ffffffff-f7e6-4a40-ab05-dc46e6dc05d2', 'API Сергій Буран', null);
alter table datasource add column sender_uuid text;
update datasource set sender_uuid='ffffffff-f7e6-4a40-ab05-dc46e6dc05d2' where id=2;
```

## 2023-06-20

```sql
ALTER TABLE restream ADD COLUMN remote_pid int8;
```

## 2023-06-23

```sql
CREATE TABLE restream_setup (
	id BIGSERIAL PRIMARY KEY,
	human text not null,
	client_id text,
	storage text,
	sink text,
	sink_2 text,
	port int8,
	user_id text,
	vezha_channel_id text
);
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  1,
  'floki.kvs@gmail.com Каскад',
  '1307969452-09lvak22bvsa3mj60otspg4men46glf0.apps.googleusercontent.com',
  'tokencache_kvs.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-1',
  'rtmp://rtmp.shiva.kmfr.link/x/cRcfCduNKwGg',
  8062,
  'wd',
  '6480c8d0d11d840d6959ae6f'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  2,
  'floki.kvs1@gmail.com Капібара',
  '508515129458-oi2gdv0gi5krf4cg3q9jg4eb9tm4o7nk.apps.googleusercontent.com',
  'tokencache_kvs1.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-2',
  'rtmp://rtmp.shiva.kmfr.link/x/SQLM5wM9bRJh',
  8063,
  'wd',
  '6480ca438628dd45708a5473'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  3,
  'floki.kvs2@gmail.com Кактус',
  '502444635103-c9oclom9tt6nsdtsm4fqbf5rocdfv3l7.apps.googleusercontent.com',
  'tokencache_kvs2.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-3',
  'rtmp://rtmp.shiva.kmfr.link/x/TUBjxAU8AFAV',
  8061,
  'wd',
  '6480caa0d11d840d6959ae72'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  4,
  'wildducksalpha@gmail.com Вишня',
  '912993328460-fg61b3v80dea06a3gq8893p8i2vi8t8h.apps.googleusercontent.com',
  'tokencache_alfa.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-4',
  'rtmp://rtmp.shiva.kmfr.link/x/R6FNppuC9z5h',
  8064,
  'wd',
  '647dc786cb23587999f72c3e'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  5,
  'wildducksbravo@gmail.com Горіх',
  '597487105114-c0btkh29g0t1bntve0b8bqom8k2n43fc.apps.googleusercontent.com',
  'tokencache_bravo.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-5',
  'rtmp://rtmp.shiva.kmfr.link/x/SUsutZP2XVFe',
  8065,
  'wd',
  '6480a53ad11d840d6959ae62'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  6,
  'wildduckscharlie@gmail.com Авокадо',
  '689692313376-c46ovk0922tq78c0mgnfmiiieaohpc57.apps.googleusercontent.com',
  'tokencache_charlie.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-6',
  'rtmp://rtmp.shiva.kmfr.link/x/citEtZiWgein',
  8066,
  'wd',
  '6481950cdd45917d88ef385c'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  7,
  'wildducksdelta@gmail.com Клен',
  '998273858411-8bfldcpj26e6476t5ongub4h0fvvhntq.apps.googleusercontent.com',
  'tokencache_delta.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-7',
  'rtmp://rtmp.shiva.kmfr.link/x/dAAFLV3Ay98T',
  8067,
  'wd',
  '6480cb36d11d840d6959ae73'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  8,
  'wildduckecho@gmail.com Маска',
  '191120090361-uqcdf8sraepnnogti718okjp1e6gt7ba.apps.googleusercontent.com',
  'tokencache_echo.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-8',
  'rtmp://rtmp.shiva.kmfr.link/x/kEyidUa44WFZ',
  8068,
  'wd',
  '6480cba4ba4ffad021ad6b70'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  9,
  'wildducksfoxtrot@gmail.com Тополя',
  '131701439269-cksreut4sd8habht7a2asu2pda4k8osm.apps.googleusercontent.com',
  'tokencache_foxtrot.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-9',
  'rtmp://rtmp.shiva.kmfr.link/x/Noitr56sL6UF',
  8069,
  'wd',
  '6480cc17d11d840d6959ae75'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  10,
  'wildducksgolf1@gmail.com Пальма',
  '349078729725-s6ova1gdq83r82tv3id5a97snea3v9vq.apps.googleusercontent.com',
  'tokencache_golf.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-10',
  'rtmp://rtmp.shiva.kmfr.link/x/6Pm92btNkJ5M',
  8070,
  'wd',
  '6480a3aeec0ec37bacd6d466'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  11,
  'wildduckshotel@gmail.com Койот',
  '70390743876-plmaf4h8igjc5k8egg9uvebn8ocaa8q0.apps.googleusercontent.com',
  'tokencache_hotel.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-11',
  'rtmp://rtmp.shiva.kmfr.link/x/WJf3ArLHQxvc',
  8071,
  'wd',
  '6480cd148b5248cf87961f87'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  12,
  'wildducksindia@gmail.com Тризуб',
  '326585478128-vdso55austhn6jjipgn4lb1bcs9r6qa6.apps.googleusercontent.com',
  'tokencache_india.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-12',
  'rtmp://rtmp.shiva.kmfr.link/x/RtsR7tgGKQWo',
  8072,
  'wd',
  '6480cddaba4ffad021ad6b72'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  13,
  'wildducksjuliett@gmail.com Дед',
  '834051717150-39o5iiucuqq9nt9jouemlutgom8hqta7.apps.googleusercontent.com',
  'tokencache_juliett.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-13',
  null,
  8073,
  'wd',
  '6480ce5edd45917d88ef381d'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  14,
  'wildduckskilo@gmail.com Аутел',
  '404780420045-tinks55qv1lgogn7qi7p3ofc93ofcv76.apps.googleusercontent.com',
  'tokencache_kilo.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-14',
  'rtmp://rtmp.shiva.kmfr.link/x/cJEDRAWPa6xj',
  8074,
  'wd',
  '6493d0be24193de086290048'
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  15,
  'wildduckslima@gmail.com',
  '470884570552-vbr8g1sbmp8ne7b9kt5b1m9tdnd7a24b.apps.googleusercontent.com',
  'tokencache_lima.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-14',
  null,
  8075,
  'wd',
  null
  );
insert into restream_setup (id, human, client_id, storage, sink, sink_2, port, user_id, vezha_channel_id)  values (
  16,
  'wildducksmike@gmail.com',
  '796406821354-cnrru0m50tbln4brhp9b1o8k4dbpt6kf.apps.googleusercontent.com',
  'tokencache_mike.json',
  'rtmp://origin1.gss.live/Zapo/zptzr_nc-14',
  null,
  8076,
  'wd',
  null
  );
```

## 2023-06-23

```sql
alter table sigint_saved_filter add column login text;
```

## 2023-07-01

```sql
insert into delta_kv (k, v) values ('buran_sync_state', '{"last_sync_t": "2023-06-01T00:00:00.000Z"}');
```

Needs stop && `sudo rm /fast/kon/storage/tokencache_*`

```sql
update restream_setup set client_id='1307969452-giqm9askostlv86l6rp5nkui28gc9o7q.apps.googleusercontent.com' where id=1;
update restream_setup set client_id='508515129458-p0ljnenl24cgcghaa2n97nmkq972js6r.apps.googleusercontent.com' where id=2;
update restream_setup set client_id='502444635103-3oc566205mnfno56mbdqmmse4p0amhve.apps.googleusercontent.com' where id=3;
update restream_setup set client_id='912993328460-lj3s6og3fmsrshikqqj6hdpp0i5b5isg.apps.googleusercontent.com' where id=4;
update restream_setup set client_id='597487105114-oav4u4011tovfisc6erle19sal93dr8s.apps.googleusercontent.com' where id=5;
update restream_setup set client_id='689692313376-96n00qnu6v55rktj06iuvjavsolsuir1.apps.googleusercontent.com' where id=6;
update restream_setup set client_id='998273858411-bpm3c1d106sjsa4qocp3nfujqt07rl37.apps.googleusercontent.com' where id=7;
update restream_setup set client_id='191120090361-jalpfjth7ko1g31o4mjb7pmjksi9rpq3.apps.googleusercontent.com' where id=8;
update restream_setup set client_id='131701439269-36icd2jo7kof2cia249om4qb2tg737et.apps.googleusercontent.com' where id=9;
update restream_setup set client_id='349078729725-ph2sjp8o6jes2fd056sa8r030sr02i4n.apps.googleusercontent.com' where id=10;
update restream_setup set client_id='70390743876-25h9g8r4e67mbfbm949crc5tqgvb7auj.apps.googleusercontent.com' where id=11;
update restream_setup set client_id='326585478128-s7gqie17e95bbn4h5rebc4vv7ee3odp0.apps.googleusercontent.com' where id=12;
update restream_setup set client_id='834051717150-5k45nr481rv3hvlo3l3r69anh0esjjil.apps.googleusercontent.com' where id=13;
update restream_setup set client_id='404780420045-kgsa32abncne2fk11omfqaj99a6lvqcp.apps.googleusercontent.com' where id=14;
update restream_setup set client_id='470884570552-k294rp24bd5erl9f46anne60j53qi2p5.apps.googleusercontent.com' where id=15;
update restream_setup set client_id='796406821354-k0igs6l16t433lt5pvp6q00ftu9ftmta.apps.googleusercontent.com' where id=16;

-- update restream_setup set client_id='1307969452-09lvak22bvsa3mj60otspg4men46glf0.apps.googleusercontent.com' where id=1;
-- update restream_setup set client_id='508515129458-oi2gdv0gi5krf4cg3q9jg4eb9tm4o7nk.apps.googleusercontent.com' where id=2;
-- update restream_setup set client_id='502444635103-c9oclom9tt6nsdtsm4fqbf5rocdfv3l7.apps.googleusercontent.com' where id=3;
-- update restream_setup set client_id='912993328460-fg61b3v80dea06a3gq8893p8i2vi8t8h.apps.googleusercontent.com' where id=4;
-- update restream_setup set client_id='597487105114-c0btkh29g0t1bntve0b8bqom8k2n43fc.apps.googleusercontent.com' where id=5;
-- update restream_setup set client_id='689692313376-c46ovk0922tq78c0mgnfmiiieaohpc57.apps.googleusercontent.com' where id=6;
-- update restream_setup set client_id='998273858411-8bfldcpj26e6476t5ongub4h0fvvhntq.apps.googleusercontent.com' where id=7;
-- update restream_setup set client_id='191120090361-uqcdf8sraepnnogti718okjp1e6gt7ba.apps.googleusercontent.com' where id=8;
-- update restream_setup set client_id='131701439269-cksreut4sd8habht7a2asu2pda4k8osm.apps.googleusercontent.com' where id=9;
-- update restream_setup set client_id='349078729725-s6ova1gdq83r82tv3id5a97snea3v9vq.apps.googleusercontent.com' where id=10;
-- update restream_setup set client_id='70390743876-plmaf4h8igjc5k8egg9uvebn8ocaa8q0.apps.googleusercontent.com' where id=11;
-- update restream_setup set client_id='326585478128-vdso55austhn6jjipgn4lb1bcs9r6qa6.apps.googleusercontent.com' where id=12;
-- update restream_setup set client_id='834051717150-39o5iiucuqq9nt9jouemlutgom8hqta7.apps.googleusercontent.com' where id=13;
-- update restream_setup set client_id='404780420045-tinks55qv1lgogn7qi7p3ofc93ofcv76.apps.googleusercontent.com' where id=14;
-- update restream_setup set client_id='470884570552-vbr8g1sbmp8ne7b9kt5b1m9tdnd7a24b.apps.googleusercontent.com' where id=15;
-- update restream_setup set client_id='796406821354-cnrru0m50tbln4brhp9b1o8k4dbpt6kf.apps.googleusercontent.com' where id=16;
```

## 2023-07-07

```sql
create table tag (
	id BIGSERIAL PRIMARY KEY,
	label text not null
);

insert into tag (id, label) values (1, 'позиції');
insert into tag (id, label) values (2, 'втрати');
insert into tag (id, label) values (3, 'бпла');
insert into tag (id, label) values (4, 'бк');
insert into tag (id, label) values (5, 'інше');

alter table sigint_inbox_item add column tags jsonb;
```

```sql
insert into tag (id, label) values (6, 'позивні');
insert into tag (id, label) values (7, 'коди');
```

## 2023-07-13

```sql
alter table tag add column extra bool;
alter table tag add column ord double precision;
update tag set ord=1.0 where id=1;
update tag set ord=2.0 where id=2;
update tag set ord=3.0 where id=3;
update tag set ord=4.0 where id=4;
update tag set ord=5.0 where id=5;
update tag set ord=6.0 where id=6;
update tag set ord=7.0 where id=7;
insert into tag (id, label, extra, ord) values (8, 'накази', true, 8.0);
update tag set label='забезп' where label='бк';
insert into tag (id, label, extra, ord) values (9, 'моральний стан', true, 9.0);
insert into tag (id, label, extra, ord) values (10, 'переміщення', true, 10.0);
insert into tag (id, label, extra, ord) values (11, 'іноземна мова', true, 11.0);
insert into tag (id, label, extra, ord) values (12, 'звʼязок', true, 12.0);
```

## 2023-07-14

```sql
alter table tag add column title text;
update tag set title='Позиції' where id=1;
update tag set title='Втрати' where id=2;
update tag set title='БпЛА' where id=3;
update tag set title='Забезпечення' where id=4;
update tag set title='Інше' where id=5;
update tag set title='Позивні' where id=6;
update tag set title='Коди' where id=7;
update tag set title='Бойові накази' where id=8;
update tag set title='Моральний стан' where id=9;
update tag set title='Переміщення ОВТ та О/С' where id=10;
update tag set title='Іноземна мова' where id=11;
update tag set title='Звʼязок' where id=12;
```

## 2023-07-16

```sql
create table comp_freq (
  id BIGSERIAL PRIMARY KEY,
  zone_id int8 REFERENCES sigint_zone (id) not null,
  freq text not null,
  first_seen timestamp without time zone,
	updated_at timestamp without time zone default (now() at time zone 'utc') not null
);
```

```sql
create table comp_freq_callsign (
  id BIGSERIAL PRIMARY KEY,
  zone_id int8 REFERENCES sigint_zone (id) not null,
  freq text not null,
  callsign text not null,
  first_seen timestamp without time zone,
  updated_at timestamp without time zone default (now() at time zone 'utc') not null
);
```

## 2023-07-20

```sql
alter table sigint_inbox_item add column callsigns_alg2 jsonb;
```

## 2023-07-21

```sql
alter table sigint_inbox_item add column callsigns_alg1 jsonb;
```

## 2023-07-25

```sql
-- drop table sigint_important;
create table sigint_important (
	id BIGSERIAL PRIMARY KEY,
	user_id text not null,
	signal_message_id int8 REFERENCES signal_message (id) not null,
	created_at timestamp without time zone default (now() at time zone 'utc') not null
);

CREATE INDEX sigint_important_signal_message_id_idx ON sigint_important ((signal_message_id::int8));
CREATE INDEX sigint_important_created_at_idx ON sigint_important ((created_at::TIMESTAMP));
```

## 2023-07-28

```sql
CREATE INDEX signal_message_timestamp_idx ON public.signal_message USING btree (timestamp);
```

## 2023-10-06

```sql
alter table tag add column enabled boolean not null default true;
```

## 2023-10-18

```sql
create table rer_gdoc_callsign (
	id BIGSERIAL PRIMARY KEY,
	created_at timestamp without time zone default (now() at time zone 'utc') not null,
	callsign text not null,
	position text not null,
	comment text not null,
	unit_1 text not null,
	unit_2 text not null
);
create index rer_gdoc_callsign_callsign_idx on rer_gdoc_callsign (callsign);
```

## 2023-11-07

```sql
create table organism (
	id BIGSERIAL PRIMARY KEY,
	name text not null,
	created_at timestamp without time zone default (now() at time zone 'utc') not null
);
alter table login add column organism_id int8 REFERENCES organism (id);
insert into organism (id, name) values (1, '190НЦ');
update login set organism_id=1 where login in ('wd', 'ziggy', 'atom', 'rer');

create table sigint_comment (
    id BIGSERIAL PRIMARY KEY,
    login text REFERENCES login (login) not null,
	signal_message_id int8 REFERENCES signal_message (id) not null,
	comment text not null,
	created_at timestamp without time zone default (now() at time zone 'utc') not null
);
create index sigint_comment_signal_message_id_idx on sigint_comment (signal_message_id);
insert into sigint_comment (login, signal_message_id, comment)
  select 'rer' as login, sii.id as signal_message_id, sii.extended_form as comment from sigint_inbox_item sii
  where sii.extended_form is not null;
alter table sigint_inbox_item drop column extended_form;
```

## 2023-11-17

```sql
CREATE OR REPLACE FUNCTION combine_date_time_text_kyiv_to_utc(date_text TEXT, time_text TEXT)
RETURNS TIMESTAMP AS $$
BEGIN
    -- Combine the date and time, interpret as Kyiv time, and convert to UTC
    RETURN (date_text::DATE + time_text::TIME) AT TIME ZONE 'Europe/Kiev' AT TIME ZONE 'UTC';
END;
$$ LANGUAGE plpgsql IMMUTABLE;

ALTER TABLE sigint_inbox_item
ADD COLUMN datetime TIMESTAMP WITHOUT TIME ZONE
GENERATED ALWAYS AS (combine_date_time_text_kyiv_to_utc(date, time)) STORED;

create index sigint_inbox_item_datetime_idx on sigint_inbox_item (datetime);
```

## 2023-12-11

```
alter table signal_group add column created_at timestamp without time zone default (now() at time zone 'utc') not null;
alter table signal_profile add column created_at timestamp without time zone default (now() at time zone 'utc') not null;
```
