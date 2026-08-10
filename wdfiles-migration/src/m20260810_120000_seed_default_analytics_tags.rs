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
                with inserted as (
                    insert into analytics_tag (id, name, rule_expression)
                    values
                        ('019fdb64-4e45-76e2-b1e8-29945f919883'::uuid, 'Втрати', '{"op": "all", "children": [{"op": "any", "children": [{"op": "match", "field": "full_path", "values": ["200", "300"], "matcher": "contains_token"}, {"op": "match", "field": "full_path", "values": ["БВП", "безвести", "ранен"], "matcher": "contains"}]}, {"op": "not", "child": {"op": "match", "field": "full_path", "values": ["Видео поражения"], "matcher": "contains"}}]}'::jsonb),
                        ('019fdb5c-70d1-72b3-b533-554037355265'::uuid, 'Доповіді', '{"op": "all", "children": [{"op": "match", "field": "full_path", "values": ["доклад", "рапорт", "внеочередн", "внесрочн", "ибд", "жбд", "вбд", "донесение", "командиру"], "matcher": "contains"}]}'::jsonb),
                        ('019fdb63-23c0-7841-9896-cc3623deb46b'::uuid, 'Озброєння', '{"op": "all", "children": [{"op": "match", "field": "full_path", "values": ["боеприпасы", "ФПВ", "FPV", "дроны", "БпЛА", "ретрик", "оружие"], "matcher": "contains_token"}, {"op": "not", "child": {"op": "match", "field": "full_path", "values": ["Видео поражения"], "matcher": "contains"}}]}'::jsonb),
                        ('019fdb5b-1673-7d23-82ab-b4b05cb119ce'::uuid, 'Штатки', '{"op": "match", "field": "full_path", "values": ["шдс", "штат", "бчс", "ротний", "алушта", "вшдр", "личный состав", "список лс"], "matcher": "contains"}'::jsonb),
                        ('019fdb5e-e895-70c0-9cd9-fbc02c4d5372'::uuid, 'Бойові документи', '{"op": "match", "field": "full_path", "values": ["цели", "позиции", "палитра", "перемещение", "район", "координаты", "противник", "ВСУ", "опорный", "ЛБС", "наблюдательный", "Видео поражения"], "matcher": "contains"}'::jsonb),
                        ('019fdb68-9ef1-7d51-82a8-a365ddd38e39'::uuid, 'Військовий файл', '{"op": "match", "field": "full_path", "values": ["важное", "противник", "тритон", "дшд", "дшп", "пдп", "дшб", "пдб", "дшр", "пдр", "шр", "мсд", "мсп", "мср", "иср", "батр", "гадн", "гсадн", "реабр", "реадн", "омсбр", "обмр", "орб", "взвод", "отделение", "расчет"], "matcher": "contains_token"}'::jsonb),
                        ('019fdaed-f5e0-7a50-ac3f-d31c101b9bf2'::uuid, 'Карти командира', '{"op": "all", "children": [{"op": "match", "field": "extension", "values": ["cdr"], "matcher": "equals"}, {"op": "not", "child": {"op": "match", "field": "full_path", "values": ["плакат", "газет"], "matcher": "contains"}}]}'::jsonb),
                        ('019fdb5d-2858-7c31-ad0c-794e9bb3b379'::uuid, 'Плани противника', '{"op": "all", "children": [{"op": "any", "children": [{"op": "match", "field": "full_path", "values": ["решение", "боевая задача", "распоряжение"], "matcher": "contains"}, {"op": "match", "field": "full_path", "values": ["РКК", "БРО"], "matcher": "contains_token"}]}, {"op": "not", "child": {"op": "match", "field": "full_path", "values": ["3D", "STL"], "matcher": "contains_token"}}]}'::jsonb),
                        ('019feace-8369-7732-aace-2907fdc7540c'::uuid, 'Профільні програми', '{"op": "match", "field": "full_path", "values": ["BlueStacks", "LD Player", "LiftOff", "BtFl", "SAS Planet", "AlpineQuest", "TrueConf", "Astra", "MissionPlanner"], "matcher": "contains"}'::jsonb),
                        ('019fdb62-317c-74c3-ad84-ed794053fce3'::uuid, 'Робота з радіо', '{"op": "all", "children": [{"op": "any", "children": [{"op": "match", "field": "full_path", "values": ["Veda", "частота", "частоты", "частот", "моторола", "моторол", "моторолы", "прошивки", "прошивок", "VD", "TYT", "radio", "рация", "рации"], "matcher": "contains_token"}, {"op": "match", "field": "file_name", "values": ["рация", "рации"], "matcher": "contains_token"}]}, {"op": "not", "child": {"op": "match", "field": "full_path", "values": ["Games", "GTA", "Counter-Strike", "Bitmap", "Forza Horizon"], "matcher": "contains"}}]}'::jsonb),
                        ('019fdb59-4305-74b0-8c19-50f2bcaacc54'::uuid, 'Маршрути, палітри', '{"op": "match", "field": "extension", "values": ["ldk", "trk", "kml", "kmz", "aqm", "aqx"], "matcher": "equals"}'::jsonb),
                        ('019fdb65-bbc0-7141-aff9-87332813a834'::uuid, 'Паролі, доступи', '{"op": "any", "children": [{"op": "match", "field": "full_path", "values": ["труконф", "trueconf", "парол", "password", "учётк", "аккаунт", "астра"], "matcher": "contains"}, {"op": "all", "children": [{"op": "match", "field": "full_path", "values": ["дс", "dc"], "matcher": "contains_token"}, {"op": "not", "child": {"op": "match", "field": "full_path", "values": ["Acrobat"], "matcher": "contains"}}]}]}'::jsonb)
                    on conflict do nothing
                    returning 1
                )
                update analytics_tag_rule_set_state
                set revision = revision + 1
                where id = true
                  and exists (select 1 from inserted);
                "#,
            )
            .await?;
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // Seeded tags become user-managed immediately and may be referenced by
        // test files or file-tag links, so rolling back must not delete them.
        Ok(())
    }
}
