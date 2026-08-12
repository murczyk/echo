use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
create table orbit_grouping_of_forces (
    id uuid primary key,
    key text not null,
    name text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
    unique (key, name)
);

create table orbit_combat_unit_type (
    id uuid primary key,
    key text not null,
    name text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
    unique (key, name)
);

create table orbit_unit_echelon (
    id uuid primary key,
    key text not null,
    name text not null,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
    unique (key, name)
);

create table orbit_unit (
    unit_id uuid primary key,
    unit_name text,
    unit_name_original text,
    unit_name_short text,
    operational_unit_name_full text,
    generative_unit_name_full text,
    unit_number text,
    unit_alternate_names text[],
    unit_alternate_numbers text[],
    unit_echelon_id uuid references orbit_unit_echelon(id),
    combat_unit_type_id uuid references orbit_combat_unit_type(id),
    grouping_of_forces_id uuid references orbit_grouping_of_forces(id),
    generative_parent_unit_id uuid,
    operational_parent_unit_id uuid,
    deleted boolean not null default false,
    created_at timestamp without time zone default (now() at time zone 'utc') not null,
    updated_at timestamp without time zone default (now() at time zone 'utc') not null,
    constraint orbit_unit_generative_parent_fk
        foreign key (generative_parent_unit_id)
        references orbit_unit(unit_id)
        deferrable initially deferred,
    constraint orbit_unit_operational_parent_fk
        foreign key (operational_parent_unit_id)
        references orbit_unit(unit_id)
        deferrable initially deferred
);

create index orbit_unit_generative_parent_idx
    on orbit_unit (generative_parent_unit_id);
create index orbit_unit_operational_parent_idx
    on orbit_unit (operational_parent_unit_id);
create index orbit_unit_active_updated_at_idx
    on orbit_unit (updated_at)
    where deleted = false;

insert into orbit_grouping_of_forces (id, key, name) values
    ('17601b62-5a22-448f-9cc7-6f044ac7e9d5', 'dnepr', 'Днепр'),
    ('4768153a-3f6b-4267-a3ef-d3945c540483', 'north', 'Север'),
    ('17e87813-ebd4-4f70-9478-e8f9d94e7176', 'south', 'Юг'),
    ('8f51cf8c-1afb-42d3-a3cf-8659b13a58c4', 'west', 'Запад'),
    ('71b4def7-9841-4b26-8359-69003f38797b', 'bryansk', 'Брянск'),
    ('24564edd-42f4-44dc-849e-eb53c5fe9cb6', 'center', 'Центр'),
    ('fa05a716-038e-486f-93ea-e5442d83015a', 'east', 'Восток'),
    ('7ab28573-d040-43d1-90ea-6b9fec3c313f', 'kursk', 'Курск'),
    ('57b86f42-906c-444e-9be7-6cfafda8a86d', 'belgorod', 'Белгород'),
    ('82980ec3-5093-43c9-8d45-ff6dc514ea7d', 'energodar', 'Енергодар'),
    ('c08a9285-9867-4df1-9375-7a2cda0cbbb5', 'belarus', 'Беларусь');

insert into orbit_combat_unit_type (id, key, name) values
    ('8fb6c894-fea8-487a-8528-7b0929d5bbb6', 'radioTechnical', 'Радіотехнічні війська'),
    ('75793033-5574-46a4-bc42-e33615122851', 'unmannedForces', 'Безпілотні системи / БПЛА'),
    ('252ce8b6-e411-4cba-8d03-6d7e5cc6db75', 'infantry', 'Мотострілецькі війська'),
    ('35d565d4-5e0d-4a04-b08b-efdb4cf3e8ba', 'artillery', 'Ракетні війська та артилерія'),
    ('2396ebdc-c68b-4824-9b54-04c4cd8a7a57', 'armour', 'Бронетанкові війська'),
    ('67925f97-ac04-4698-806f-b1b857c1c31f', 'signal', 'Війська зв’язку'),
    ('b4d0e24b-fec9-4671-a391-4e22164a3e76', 'other', 'Інші'),
    ('0e47727d-9421-41e7-bc0f-86c0ff49c684', 'specialForcesOfNavy', 'Спеціальні війська ВМФ'),
    ('a7ec31ee-fa62-48bd-bc61-14ba64a6484d', 'engineering', 'Інженерні війська'),
    ('2118ba27-0631-4647-9795-00a7bcc89cfa', 'antiAircraftMissile', 'Зенітно-ракетні війська'),
    ('19f56e47-2623-4bac-8054-2ca6455f6ede', 'electronicWarfare', 'Війська РЕБ'),
    ('12ee140b-76d2-43da-a025-a3285a04a583', 'groundForces', 'Сухопутні війська'),
    ('02f3c1cc-542b-49ec-8484-ca59c1e6ad72', 'coastal', 'Берегові війська ВМФ'),
    ('06a01a5a-a4b4-495f-a29c-c40e9d679b8b', 'radiationChemBioDefense', 'Війська РХБЗ'),
    ('f196fee5-dc58-4b76-a399-e1e191ed2dfb', 'airborne', 'Повітряно-десантні війська'),
    ('9dc67ebe-e041-4677-a7a2-d951e5aaa187', 'airAndMissileDefense', 'Війська ППО-ПКО'),
    ('e2beb5a0-9f40-4f3c-aa04-2ce849876933', 'spaceForces', 'Космічні війська'),
    ('8b9019ff-6d13-4d3e-955b-560d3aba914f', 'specialOpsForces', 'Сили спеціальних операцій'),
    ('8d0ddb3d-a075-4325-ab49-d0c4f61949ac', 'airDefense', 'Війська ППО СВ'),
    ('5ab8bd6a-e457-4627-ba2c-97b885413c8d', 'combatAviation', 'Армійська авіація');

insert into orbit_unit_echelon (id, key, name) values
    ('bf07d907-a865-42cd-a3cb-f5507102c108', 'battalion', 'Батальйон / дивізіон'),
    ('e1d2a27c-2433-4693-81e6-ff6ced71bed7', 'armyRegion', 'Регіон / ТВД / Збройні Сили'),
    ('36ce1ced-10d8-4eb7-8c4a-b86e77e41b0a', 'militaryDistrict', 'Група армій / фронт / види та роди Збройних Сил'),
    ('17d2d2ce-697f-4a6d-bfb4-b9af842fd3b6', 'fieldArmy', 'Армія / ОК / ОУВ / ПвК'),
    ('4ad7355d-8f00-49c5-836b-5fc4865b9a7f', 'brigade', 'Бригада'),
    ('8f944a79-ffb0-4460-a8e6-3aa29aaaefe4', 'teamOrCrew', 'Розрахунок / екіпаж'),
    ('73e99c6d-e89b-4808-95b1-732b104d53c3', 'regiment', 'Полк / група'),
    ('bc9c8a6c-0c46-48ed-a73c-70ae004039ba', 'platoon', 'Взвод / загін'),
    ('eedd9ed5-6d1b-47cb-a464-6ceb7d9b3470', 'company', 'Рота / батарея'),
    ('3c2f01e3-1fc7-4a8c-814a-d642a4346bba', 'corps', 'Корпус / ОТУ / МК / КМП'),
    ('a0e9f79c-906d-49b3-9739-b3e74d788aec', 'division', 'Дивізія'),
    ('fccd4e5f-e91b-4371-8634-f4479101db55', 'other', 'Інше'),
    ('75679f26-0dd6-4cd6-b888-8b5aef035d1e', 'squad', 'Відділення'),
    ('0e6f9634-4f06-4137-84eb-20f7ead132e3', 'section', 'Секція');
"#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
drop table if exists orbit_unit;
drop table if exists orbit_unit_echelon;
drop table if exists orbit_combat_unit_type;
drop table if exists orbit_grouping_of_forces;
"#,
            )
            .await?;
        Ok(())
    }
}
