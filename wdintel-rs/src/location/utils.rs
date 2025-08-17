use crate::location::SettlementDetails;

pub fn format_location(location: &str) -> String {
    format!("|{}|", location.to_uppercase())
}

pub fn to_location_list(text: &str) -> Vec<String> {
    text.split("|")
        .map(|s| String::from(s.trim()))
        .filter(|l| !l.is_empty())
        .collect()
}

pub fn format_locations_list(result: Vec<String>) -> String {
    format!("|{}|", result.join("|"))
}

pub fn format_settlements_list(result: Vec<SettlementDetails>) -> String {
    format!(
        "|{}|",
        result
            .into_iter()
            .map(|row| row.name)
            .collect::<Vec<_>>()
            .join("|")
    )
}
