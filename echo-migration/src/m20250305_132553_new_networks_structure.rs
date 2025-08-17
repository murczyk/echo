use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            "
-- create new sigint_network_freq table
CREATE TABLE sigint_network_freq (
	id bigserial NOT NULL,
	network_id int8 NOT NULL,
	freq text NOT NULL,
	deleted bool DEFAULT false NOT NULL, 
	created_at timestamp DEFAULT (now() AT TIME ZONE 'utc'::text) NOT NULL,
	CONSTRAINT sigint_network_freq_pkey PRIMARY KEY (id),
	CONSTRAINT sigint_network_freq_network_id_fkey FOREIGN KEY (network_id) REFERENCES sigint_network(id)
	-- CONSTRAINT sigint_network_freq_freq_fkey FOREIGN KEY (freq) REFERENCES sigint_inbox_item(freq)
);

-- create index on freq column
CREATE INDEX sigint_network_freq_freq_idx ON sigint_network_freq USING btree (freq);

-- create index on network_id column
CREATE INDEX sigint_network_freq_network_id_idx ON sigint_network_freq (network_id);

-- copy data from sigint_network to sigint_network_freq
insert into sigint_network_freq (network_id, freq, deleted)
select sn.id, sn.freq, sn.deleted
from sigint_network sn;

-- create new user defined data type for network transmission type
create type sigint_network_transmission_type as ENUM ('NFM', 'AM', 'DMR');

-- add new columns to sigint_network
ALTER TABLE sigint_network ADD COLUMN trans_type sigint_network_transmission_type not null default 'NFM';   -- Вид передачі
ALTER TABLE sigint_network ADD COLUMN purpose text;                     -- Призначення
ALTER TABLE sigint_network ADD COLUMN operation_mode text;              -- Режим роботи радіомережі 
ALTER TABLE sigint_network ADD COLUMN operation_type text;              -- Характер роботи
ALTER TABLE sigint_network ADD COLUMN operation_period text;            -- Період функціонування
ALTER TABLE sigint_network ADD COLUMN signs text;                       -- Додаткові розвідувальні ознаки підрозділу
ALTER TABLE sigint_network ADD COLUMN merged_to int8;                   -- Ознака мережі змерженої в іншу мережу

UPDATE sigint_network SET trans_type = 'NFM' WHERE trans_type IS NULL;
",
        )
        .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
        "
--create index on freq column 
CREATE INDEX sigint_network_freq_idx ON public.sigint_network USING btree (freq);

-- copy data from sigint_network_freq to sigint_network
update sigint_network sn
set freq = snf.freq
from sigint_network_freq snf
where sn.id = snf.network_id;

-- delete columns from sigint_network
ALTER TABLE sigint_network DROP COLUMN trans_type;
ALTER TABLE sigint_network DROP COLUMN purpose;
ALTER TABLE sigint_network DROP COLUMN operation_mode;
ALTER TABLE sigint_network DROP COLUMN operation_type;
ALTER TABLE sigint_network DROP COLUMN operation_period;
ALTER TABLE sigint_network DROP COLUMN signs;
ALTER TABLE sigint_network DROP COLUMN merged_to;

-- drop user defined data type for network transmission type
DROP TYPE sigint_network_transmission_type;

-- drop sigint_network_freq table
DROP TABLE sigint_network_freq;
",
        )
        .await?;
        Ok(())
    }
}
