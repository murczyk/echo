use crate::location::SettlementDetails;

pub fn format_location(location: &String) -> String {
    format!("|{}|", location.to_uppercase())
}

pub fn to_location_list(text: &String) -> Vec<String> {
    text.clone()
        .split("|")
        .into_iter()
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
            .map(|(name, _)| name)
            .collect::<Vec<_>>()
            .join("|")
    )
}
