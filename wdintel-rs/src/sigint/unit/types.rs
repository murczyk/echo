use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::Deserializer;
use serde::{Deserialize, Serialize};

fn deserialize_optional_update<'de, D, T>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct Unit {
    pub id: i64,
    pub company: String,
    pub battalion: String,
    pub regiment: String,
    pub division: String,
    pub army: String,
    #[serde(default)]
    pub military_district: String,
    #[serde(default)]
    pub army_region: String,
    pub comment: String,
    pub orbit_note: Option<String>,
    pub name: String,
    pub active: bool,
    pub is_deduplicate_candidate: Option<bool>,
    pub created_at: i64,
    pub created_by_login_id: String,
    #[serde(default, skip_deserializing)]
    pub has_orbit: bool,
    #[serde(default, skip_deserializing)]
    pub orbit_unit_ids: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_without_has_orbit_deserializes() {
        let unit: Unit = serde_json::from_value(serde_json::json!({
            "id": 1,
            "company": "",
            "battalion": "",
            "regiment": "",
            "division": "",
            "army": "",
            "comment": "",
            "name": "unit",
            "active": true,
            "created_at": 0,
            "created_by_login_id": ""
        }))
        .unwrap();

        assert!(!unit.has_orbit);
        assert_eq!(unit.is_deduplicate_candidate, None);
        assert_eq!(unit.military_district, "");
        assert_eq!(unit.army_region, "");
    }

    #[test]
    fn list_units_request_defaults_to_active_units() {
        let req: ListUnitsReq = serde_json::from_value(serde_json::json!({
            "sort_by": null,
            "after_unit_id": null,
            "before_unit_id": null
        }))
        .unwrap();

        assert!(!req.include_inactive);
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListUnitsSortBy {
    CreatedAtDesc,
    CreatedAtAsc,
    NaturalMilitarySortAsc,
    UnitNameAsc,
    UnitNameDesc,
    UnitCompanyAsc,
    UnitCompanyDesc,
    UnitBattalionAsc,
    UnitBattalionDesc,
    UnitRegimentAsc,
    UnitRegimentDesc,
    UnitDivisionAsc,
    UnitDivisionDesc,
    UnitArmyAsc,
    UnitArmyDesc,
    UnitMilitaryDistrictAsc,
    UnitMilitaryDistrictDesc,
    UnitArmyRegionAsc,
    UnitArmyRegionDesc,
    UnitCommentAsc,
    UnitCommentDesc,
    UnitOrbitNoteAsc,
    UnitOrbitNoteDesc,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ListUnitsSearchMode {
    Strict,
    Relaxed,
}

#[derive(
    Elm,
    ElmEncode,
    ElmDecode,
    Debug,
    Serialize,
    Deserialize,
    PartialEq,
    Clone,
    Default,
)]
pub struct ListUnitsReq {
    pub sort_by: Option<ListUnitsSortBy>,
    pub after_unit_id: Option<i64>,
    pub before_unit_id: Option<i64>,
    #[serde(default)]
    pub include_inactive: bool,
    pub filter_active: Option<bool>,
    pub filter_text: Option<String>,
    pub filter_name: Option<String>,
    pub filter_company: Option<String>,
    pub filter_battalion: Option<String>,
    pub filter_regiment: Option<String>,
    pub filter_division: Option<String>,
    pub filter_army: Option<String>,
    pub filter_military_district: Option<String>,
    pub filter_army_region: Option<String>,
    pub filter_comment: Option<String>,
    pub filter_orbit_note: Option<String>,
    pub search_mode: Option<ListUnitsSearchMode>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnitsRsp {
    pub show_load_more: bool,
    pub total_count: i64,
    pub units: Vec<Unit>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitStatusCountsRsp {
    pub active: i64,
    pub inactive: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnitsByIdReq {
    pub ids: Option<Vec<i64>>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ListUnitsByIdRsp {
    pub units: Vec<Unit>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateUnitReq {
    pub company: String,
    pub battalion: String,
    pub regiment: String,
    pub division: String,
    pub army: String,
    #[serde(default)]
    pub military_district: String,
    #[serde(default)]
    pub army_region: String,
    pub active: bool,
    pub is_deduplicate_candidate: Option<bool>,
    pub comment: String,
    pub orbit_note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateUnitReq {
    pub id: i64,
    pub company: String,
    pub battalion: String,
    pub regiment: String,
    pub division: String,
    pub army: String,
    #[serde(default)]
    pub military_district: Option<String>,
    #[serde(default)]
    pub army_region: Option<String>,
    pub active: bool,
    pub comment: String,
    #[serde(default, deserialize_with = "deserialize_optional_update")]
    pub orbit_note: Option<Option<String>>,
}

impl From<Unit> for UpdateUnitReq {
    fn from(unit: Unit) -> Self {
        Self {
            id: unit.id,
            company: unit.company,
            battalion: unit.battalion,
            regiment: unit.regiment,
            division: unit.division,
            army: unit.army,
            military_district: Some(unit.military_district),
            army_region: Some(unit.army_region),
            active: unit.active,
            comment: unit.comment,
            orbit_note: Some(unit.orbit_note),
        }
    }
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateUnitWithAutoNetworkReq {
    pub unit: CreateUnitReq,
    pub skip_network_creation: bool,
    pub locations: Vec<String>,
    pub unit_mask: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateUnitWithAutoNetworkRsp {
    pub unit: Unit,
    pub network_id: Option<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateDeviceNetworkReq {
    pub unit_id: i64,
    pub locations: Vec<String>,
    pub unit_mask: Vec<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CreateDeviceNetworkRsp {
    pub network_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteUnitDuplicateReq {
    pub clone_to_delete_id: i64,
    pub original_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitSearchReq {
    pub search: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitDetailsReq {
    pub unit_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitAttachmentAor {
    pub id: i64,
    pub name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitAttachment {
    pub id: i64,
    pub unit_id: i64,
    pub file_name: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub short_description: String,
    pub full_description: String,
    pub aors: Option<Vec<UnitAttachmentAor>>,
    pub created_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitDetailsRsp {
    pub unit: Unit,
    pub attachments: Vec<UnitAttachment>,
    pub orbit_units: Vec<OrbitUnitDetails>,
    #[serde(default)]
    pub can_link_orbit_unit: bool,
    #[serde(default)]
    pub can_create_device_network: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrbitDictionaryValue {
    pub id: String,
    pub key: String,
    pub name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrbitParentUnit {
    pub sigint_unit_id: Option<i64>,
    pub name: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrbitChildUnit {
    pub sigint_unit_id: i64,
    pub name: String,
    pub active: bool,
    pub orbit_unit_ids: Vec<String>,
    pub is_generative: bool,
    pub is_operational: bool,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitOrbitChildrenRsp {
    pub units: Vec<OrbitChildUnit>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrbitUnitDetails {
    pub unit_id: String,
    pub unit_name: Option<String>,
    pub unit_name_original: Option<String>,
    pub unit_name_short: Option<String>,
    pub operational_unit_name_full: Option<String>,
    pub generative_unit_name_full: Option<String>,
    pub unit_number: Option<String>,
    pub unit_alternate_names: Option<Vec<String>>,
    pub unit_alternate_numbers: Option<Vec<String>>,
    pub unit_echelon: Option<OrbitDictionaryValue>,
    pub combat_unit_type: Option<OrbitDictionaryValue>,
    pub grouping_of_forces: Vec<OrbitDictionaryValue>,
    pub generative_parent_unit_id: Option<String>,
    pub operational_parent_unit_id: Option<String>,
    pub generative_parent_units: Vec<OrbitParentUnit>,
    pub operational_parent_units: Vec<OrbitParentUnit>,
    pub deleted: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrbitUnitLinkCandidate {
    pub unit_id: String,
    pub full_name: String,
    pub generative_unit_name_full: String,
    pub operational_unit_name_full: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrbitUnitLinkCandidatesReq {
    pub unit_id: i64,
    pub search: Option<String>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrbitUnitLinkCandidatesRsp {
    pub units: Vec<OrbitUnitLinkCandidate>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct OrbitUnitSearchReq {
    pub search: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct ImportOrbitUnitReq {
    pub orbit_unit_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct LinkOrbitUnitReq {
    pub sigint_unit_id: i64,
    pub orbit_unit_id: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitAttachmentUnitIdsRsp {
    pub unit_ids: Vec<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UpdateUnitAttachmentReq {
    pub attachment_id: i64,
    pub short_description: String,
    pub full_description: String,
    pub aor_ids: Vec<i64>,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteUnitAttachmentReq {
    pub attachment_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct DeleteUnitAttachmentRsp {
    pub attachment_id: i64,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UnitAttachmentDownloadReq {
    pub attachment_id: i64,
}
