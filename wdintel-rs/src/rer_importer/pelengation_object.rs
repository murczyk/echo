pub fn extract(body: &str) -> Option<String> {
    crate::rer_importer::zp_peleng_extended_format::parse(body)
        .map(|parsed| parsed.pelengation_object)
        .or_else(|| crate::unit::parser::try_extract_report_125_unit(body))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_report_125_name() {
        let body = r#"31.07.2026 14:36:52
Назва: РЛС 9С35М ЗРК “Бук-М1”;
Умовні координати для бота: MGRS 37U DR 25041 12982;
Кут: 92;
Частота: 6778;
Період слідування (Ti,мкс): 40; 984; 10; 967; 1061;
Тривалість імпульсу (τi,мкс): 3.6; 9; 94; 42; 48;
---------- ☿ Oscar_VR ☿ ----------"#;

        assert_eq!(extract(body).as_deref(), Some("РЛС 9С35М ЗРК “Бук-М1”"));
    }
}
