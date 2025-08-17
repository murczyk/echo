use crate::error::AppError;
use crate::utils::*;
use lazy_static::lazy_static;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Used in KMZ lines
pub const COLOR_FRIENDLY_LINE: &str = "ffffb215"; // ff80e0ff
pub const COLOR_NEUTRAL_LINE: &str = "ff06ff23"; // ff75fb4c
pub const COLOR_UNKNOWN_LINE: &str = "ff08ffff"; // ffffff54
pub const COLOR_HOSTILE_LINE: &str = "ff0500fc"; // ffea3323

pub fn get_icon_path(config: &crate::config::Config) -> PathBuf {
    PathBuf::from(config.static_path.clone())
        .join("img")
        .join("google_earth_icons")
}

/// Logs failures as warnings
pub fn convert_tsup_icon(tsup_icon: &str) -> Result<String, AppError> {
    lazy_static! {
        static ref RE_IFO2: Regex = Regex::new(r"ІФО 2").unwrap();
        static ref RE_IFO: Regex = Regex::new(r"ІФО").unwrap();
        static ref RE_PPO: Regex = Regex::new(r"ППО").unwrap();
        static ref RE_BTR: Regex = Regex::new(r"БТР").unwrap();
        static ref RE_VAT: Regex = Regex::new(r"ВАТ").unwrap();
        static ref RE_ARTA_SAU: Regex = Regex::new(r"Арта САУ").unwrap();
        static ref RE_INSHA_BBM: Regex = Regex::new(r"Інша ББМ").unwrap();
        static ref RE_MIST_PANTON: Regex = Regex::new(r"Міст пантон").unwrap();
        static ref RE_RSZO: Regex = Regex::new(r"РСЗО").unwrap();
        static ref RE_PAROM: Regex = Regex::new(r"Паром").unwrap();
        static ref RE_RADAR: Regex = Regex::new(r"Радар").unwrap();
        static ref RE_PIHOTA: Regex = Regex::new(r"Піхота").unwrap();
        static ref RE_PIHOTA2: Regex = Regex::new(r"піхота").unwrap();
        static ref RE_AVTO: Regex = Regex::new(r"Цивільна автівка").unwrap();
        static ref RE_TANK: Regex = Regex::new(r"Танк").unwrap();
        static ref RE_MORTAR: Regex = Regex::new(r"Міномет").unwrap();
        static ref RE_UAV_FRIEND: Regex = Regex::new(r"БПЛА_дружн??").unwrap();
        static ref RE_UAV: Regex = Regex::new(r"БПЛА").unwrap();
        static ref RE_INZHENERNYI_PIDROZDIL: Regex =
            Regex::new(r"Інженерний підрозділ").unwrap();
        static ref RE_MEDICS_FRIEND: Regex =
            Regex::new(r"Медичн.*дружн").unwrap();
        static ref RE_MEHANIZOVANI_OIVT: Regex = Regex::new(r"ОіВТ").unwrap();
        static ref RE_HQ: Regex = Regex::new(r"Штаб").unwrap();
        static ref RE_MINES: Regex = Regex::new(r"(?i)міни").unwrap();
        static ref RE_LOGISTICS: Regex = Regex::new(r"Логістика, БК").unwrap();
        static ref RE_REB: Regex = Regex::new(r"РЕБ").unwrap();
        static ref RE_ZAGAL: Regex = Regex::new(r"00_Загально").unwrap();
        static ref RE_COMM_FRIENDLY: Regex =
            Regex::new(r"підрозділ?звязку?дружн??.png").unwrap();
        static ref RE_BLOKPOST: Regex = Regex::new(r"Блокпост").unwrap();
        static ref RE_IFO_UND: Regex =
            Regex::new(r"Underground-Facility_MGRS-Mapper").unwrap();
        static ref RE_HELICOPTER: Regex = Regex::new(r"Гелікоптер").unwrap();
    }

    if RE_IFO2.is_match(tsup_icon) {
        Ok("ІФО 2.png".to_string())
    } else if RE_IFO.is_match(tsup_icon) {
        Ok("ІФО.png".to_string())
    } else if RE_PPO.is_match(tsup_icon) {
        Ok("ППО.png".to_string())
    } else if RE_BTR.is_match(tsup_icon) {
        Ok("БТР.png".to_string())
    } else if RE_VAT.is_match(tsup_icon) {
        Ok("ВАТ.png".to_string())
    } else if RE_ARTA_SAU.is_match(tsup_icon) {
        Ok("Арта САУ.png".to_string())
    } else if RE_INSHA_BBM.is_match(tsup_icon) {
        Ok("Інша ББМ.png".to_string())
    } else if RE_MIST_PANTON.is_match(tsup_icon) {
        Ok("Міст пантон.png".to_string())
    } else if RE_RSZO.is_match(tsup_icon) {
        Ok("РСЗО.png".to_string())
    } else if RE_PAROM.is_match(tsup_icon) {
        Ok("Паром.png".to_string())
    } else if RE_RADAR.is_match(tsup_icon) {
        Ok("Радар.png".to_string())
    } else if RE_PIHOTA.is_match(tsup_icon) || RE_PIHOTA2.is_match(tsup_icon) {
        Ok("Піхота.png".to_string())
    } else if RE_AVTO.is_match(tsup_icon) {
        Ok("Цивільна автівка.png".to_string())
    } else if RE_INZHENERNYI_PIDROZDIL.is_match(tsup_icon) {
        Ok("Інженерний підрозділ.png".to_string())
    } else if RE_MEHANIZOVANI_OIVT.is_match(tsup_icon) {
        Ok("ОіВТ.png".to_string())
    } else if RE_TANK.is_match(tsup_icon) {
        Ok("Танк.png".to_string())
    } else if RE_MORTAR.is_match(tsup_icon) {
        Ok("Міномет РОВ.png".to_string())
    } else if RE_UAV_FRIEND.is_match(tsup_icon) {
        Ok("БПЛА_дружній.png".to_string())
    } else if RE_UAV.is_match(tsup_icon) {
        Ok("БПЛА.png".to_string())
    } else if RE_MEDICS_FRIEND.is_match(tsup_icon) {
        Ok("Медичний_підрозділ_дружній.png".to_string())
    } else if RE_HQ.is_match(tsup_icon) {
        Ok("Штаб.png".to_string())
    } else if RE_MINES.is_match(tsup_icon) {
        Ok("Міни.png".to_string())
    } else if RE_LOGISTICS.is_match(tsup_icon) {
        Ok("Логістика, БК.png".to_string())
    } else if RE_REB.is_match(tsup_icon) {
        Ok("РЕБ.png".to_string())
    } else if RE_ZAGAL.is_match(tsup_icon) {
        Ok("00_Загально.png".to_string())
    } else if RE_COMM_FRIENDLY.is_match(tsup_icon) {
        Ok("Підрозділ звязку.png".to_string())
    } else if RE_BLOKPOST.is_match(tsup_icon) {
        Ok("Блокпост.png".to_string())
    } else if RE_IFO_UND.is_match(tsup_icon) {
        Ok("ІФО 2.png".to_string())
    } else if RE_HELICOPTER.is_match(tsup_icon) {
        Ok("Гелікоптер.png".to_string())
    } else {
        println!("warning: icon not converted: {tsup_icon}");
        Ok("00_Загально.png".to_string())
    }
}

pub fn extract_atak_event_type_by_icon(
    icon: &str,
) -> Result<Option<String>, AppError> {
    let path = icon;
    if path.ends_with("ІФО 2.png") || path.ends_with("ІФО.png") {
        return Ok(Some("a-h-U".to_string()));
    } else if path.ends_with("ППО.png") {
        return Ok(Some("a-h-G-E-W-M-A-L".to_string()));
    } else if path.ends_with("БТР.png") {
        return Ok(Some("a-h-G-E-V-A".to_string()));
    } else if path.ends_with("ВАТ.png") {
        return Ok(Some("a-h-G-U-S-T".to_string()));
    } else if path.ends_with("Арта САУ.png") {
        return Ok(Some("a-h-G-U-C-F-H-H".to_string()));
    } else if path.ends_with("Інша ББМ.png") {
        return Ok(Some("a-h-G-U-C-A-T".to_string()));
    } else if path.ends_with("Міст пантон.png") {
        return Ok(Some("a-h-G-I-T".to_string()));
    } else if path.ends_with("РСЗО.png") {
        return Ok(Some("a-h-G-E-W-X".to_string()));
    } else if path.ends_with("Паром.png") {
        return Ok(Some("a-h-G-I-T".to_string()));
    } else if path.ends_with("Радар.png") {
        return Ok(Some("a-h-G-U-U-M-S-E-J".to_string()));
    } else if path.ends_with("Піхота.png") {
        return Ok(Some("a-h-G-U-C-I".to_string()));
    } else if path.ends_with("Інженерний підрозділ.png") {
        return Ok(Some("a-h-G-U-C-E".to_string()));
    } else if path.ends_with("ОіВТ.png") {
        return Ok(Some("a-h-G-U-C-A-W".to_string()));
    }
    println!("warning: atak icon not converted: {icon}");
    Ok(None)
}

// https://docs.google.com/document/d/1EbAB2WnnAKv0cmxOP0DooSu7H-7h_A6F9zxBLQMosAA/edit
pub fn filename_to_app6d_code(x: &str) -> String {
    lazy_static! {
        static ref RE_APP6D: Regex = Regex::new(
            r".*(?P<code>\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d)\.png"
        )
        .unwrap();
    }
    if x == "icon-9_17.png" {
        "10061500001201010000".to_string() // ромб з двома вертикальними паличками
    } else if x == "icon-4_30.png" {
        "10061500001200000000".to_string() // транспортний засіб
    } else if x == "icon-2_30.png" {
        "10061500321401000000".to_string() // прямокутник з трьома колесами
    } else if x == "icon-1_32.png" {
        "10061500001200000000".to_string() // транспортний засіб
    } else if x == "icon-9_16.png" {
        "10061500001201010000".to_string() // ромб з двома вертикальними паличками
    } else if x == "icon-3_30.png"
        || x == "icon-6_22.png"
        || x == "icon-2_29.png"
        || x == "icon-1.png"
    {
        "10061500001200000000".to_string() // транспортний засіб
    } else if x == "icon-1_28" {
        "10061500321401000000".to_string() // прямокутник з трьома колесами
    } else if x == "icon-7_22"
        || x == "icon-5_27.png"
        || x == "icon-5_29.png"
        || x == "icon-2_28.png"
        || x == "icon-3.png"
    {
        "10061500001200000000".to_string() // транспортний засіб
    } else if x == "icon-4_29.png" {
        "10060100001101020000".to_string() // буква А замість літачка
    } else if x == "icon-8_18.png" {
        "10061000001303010000".to_string() // овал и круг
    } else if x.starts_with("ОіВТ") {
        "10061000001211020000".to_string() // хрест піхота та овал
    } else if x.starts_with("Танк") {
        "10061500001202000000".to_string() // квадрат з ручками
    } else if x.starts_with("РСЗО") {
        "10061500001116000000".to_string() // перевернутий тризуб без палки
    } else if x.starts_with("РСЗВ") {
        "10061500001116000000".to_string() // перевернутий тризуб без палки
    } else if x.starts_with("Піхота") {
        "10061000001211000000".to_string() // хрест піхота
    } else if x.starts_with("ППО") {
        "10061500001111000000".to_string() // дуга знизу меча ППО
    } else if x.starts_with("ВАТ") {
        "10061500001408000000".to_string() // колесико ВАТ
    } else if x.starts_with("Арта САУ")
        || x.starts_with("САУ")
        || x.starts_with("Важка артилерія РОВ")
    {
        "10061000001303010000".to_string() // чорна точка в еліпсі
    } else if x.starts_with("Радар") {
        "10061500002203000000".to_string() // блискавка в дузі
    } else if x.starts_with("РЕР") {
        "10061000001110000000".to_string() // блискавка
    } else if x.starts_with("signal") {
        // "10060000000000000000".to_string() // знак питання
        "10061000001110010000".to_string() // Command and Control - Signal - Radio
    } else if x.starts_with("БПЛА") {
        "10061000001219000000".to_string() // БПЛА
    } else if x.starts_with("Міномет РОВ") {
        "10061500001114000000".to_string() // стрілка вгору з кільцем внизу
    } else if x.starts_with("Гранатомет") {
        "10061500001114000000".to_string()
    } else if x.starts_with("Особовий склад, піхота") {
        "10061000001211000000".to_string() // хрест піхота
    } else if x.starts_with("ІФО") {
        "10062500002811000000".to_string() // Квадрат
    } else if x.starts_with("Механізовані, ОіВТ") {
        "10061000000000000000".to_string()
    } else if x.starts_with("ОіВТ") {
        "10061000000000000000".to_string()
    } else if x.starts_with("РЕБ") {
        "10061000001505000000".to_string()
    } else if x.starts_with("Штаб") {
        "10061000001100000000".to_string()
    } else if x.starts_with("00_Загально") {
        "10061000000000000000".to_string()
    } else if x.starts_with("Логістика, БК") {
        "10062000001103000000".to_string()
    } else if x.starts_with("Блокпост") {
        "10062500001303000000".to_string()
    } else if x.starts_with("Інша ББМ") {
        "10061500001201000000".to_string() // еліпс з буквою A
    } else if x.starts_with("БТР") {
        "10061500001201030000".to_string()
    } else if x.starts_with("Гелікоптер") {
        "10060100001102000000".to_string()
    } else if x.starts_with("Інженерний підрозділ") {
        "10061000001407000000".to_string()
    } else if x.starts_with("міни") {
        "10061500002100000000".to_string()
    } else if x.starts_with("Рембаза") {
        "10062000001213060000".to_string()
    } else if x.starts_with("Цивільна автівка") {
        "10061500001603000000".to_string()
    } else if x.starts_with("Підрозділ звязку") {
        "10061000001110000000".to_string()
    } else if x.starts_with("interest_point_yellow") {
        "10012500001313000000".to_string()
    } else if x.starts_with("interest_point_red") {
        "10062500001313000000".to_string()
    } else if let Some(capts) = RE_APP6D.captures(x) {
        let Some(code) = m_cap_s(&capts, "code") else {
            return "10061000001211020000".to_string(); // ОіВТ: Movement and Manoeuvre - Infantry - Armoured/Mechanized/Tracked
        };
        code.to_string()
    } else {
        println!("> unrecognized icon: {x}");
        "10061000001211020000".to_string() // ОіВТ: Movement and Manoeuvre - Infantry - Armoured/Mechanized/Tracked
    }
}

/// Lists all APP6D icons present in ../wdintel-web/public/img/google_earth_icons
pub fn list_all_app6d_icons(
    config: &crate::config::Config,
) -> Result<Vec<String>, AppError> {
    lazy_static! {
        static ref RE_APP6D: Regex =
            Regex::new(r"\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d\d\)?\.png")
                .unwrap();
    }
    let mut res = vec![];
    let icon_path = get_icon_path(config);
    for f in std::fs::read_dir(icon_path)? {
        let f = f?;
        let f = f
            .path()
            .file_name()
            .ok_or("impossible seed=219823")?
            .to_str()
            .ok_or("impossible seed=891303")?
            .to_string();
        if RE_APP6D.is_match(&f) {
            res.push(
                f.strip_suffix(".png")
                    .ok_or("impossible! no .png suffix")?
                    .to_string(),
            );
        }
    }
    Ok(res)
}

/// 10-0-3-25-0-0-00-110101-00-00
#[derive(Debug, Serialize, Deserialize, PartialEq, Clone)]
pub struct App6d {
    pub group1: String,
    pub context: String,
    pub identity: String,
    pub symbol_set: String,
    pub status: String,
    pub headquaters_or_task_force: String,
    pub echelon_or_mobility_or_towed_array: String,
    pub main_icon: String,
    pub modifier1: String,
    pub modifier2: String,
}

pub fn parse_app6d(s: &str) -> Result<App6d, AppError> {
    lazy_static! {
        static ref RE_APP6D: Regex =
            Regex::new(r"(?P<g1>\d\d)(?P<g2>\d)(?P<g3>\d)(?P<g4>\d\d)(?P<g5>\d)(?P<g6>\d)(?P<g7>\d\d)(?P<g8>\d\d\d\d\d\d)(?P<g9>\d\d)(?P<g10>\d\d)")
            .unwrap();
    }
    let cs = RE_APP6D.captures(s).ok_or("failed parsing app6d")?;
    let g1: String = cs.name("g1").ok_or("No match g1")?.as_str().to_string();
    let g2: String = cs.name("g2").ok_or("No match g2")?.as_str().to_string();
    let g3: String = cs.name("g3").ok_or("No match g3")?.as_str().to_string();
    let g4: String = cs.name("g4").ok_or("No match g4")?.as_str().to_string();
    let g5: String = cs.name("g5").ok_or("No match g5")?.as_str().to_string();
    let g6: String = cs.name("g6").ok_or("No match g6")?.as_str().to_string();
    let g7: String = cs.name("g7").ok_or("No match g7")?.as_str().to_string();
    let g8: String = cs.name("g8").ok_or("No match g8")?.as_str().to_string();
    let g9: String = cs.name("g9").ok_or("No match g9")?.as_str().to_string();
    let g10: String =
        cs.name("g10").ok_or("No match g10")?.as_str().to_string();
    Ok(App6d {
        group1: g1,
        context: g2,
        identity: g3,
        symbol_set: g4,
        status: g5,
        headquaters_or_task_force: g6,
        echelon_or_mobility_or_towed_array: g7,
        main_icon: g8,
        modifier1: g9,
        modifier2: g10,
    })
}

/// "10061500001408000000" -> "ВАТ"
pub fn app6d_to_category(app6d: &str) -> Result<String, AppError> {
    if app6d == "10061500001408000000" {
        Ok("ВАТ".to_string())
    } else if app6d == "10062500002811000000" {
        Ok("ІФО".to_string())
    } else if app6d == "10062700001101010000" {
        Ok("о/с".to_string())
    } else if app6d == "10061500001201010000" {
        Ok("ББМ".to_string())
    } else if app6d == "10061500001601000000" {
        Ok("Легковий автомобіль".to_string())
    } else if app6d == "10062000000000000000" {
        Ok("Казарма".to_string())
    } else if app6d == "10061500001201090000" {
        Ok("Джипи, пікапи, буси".to_string())
    } else if app6d == "10061500001605020000" {
        Ok("Інший джип".to_string())
    } else if app6d == "10062500002819010000" {
        Ok("Протитанкові перешкоди".to_string())
    } else if app6d == "10061500001202020000" {
        Ok("Танк".to_string())
    } else if app6d == "10061000001211000000" {
        Ok("Скупчення ОС".to_string())
    } else if app6d == "10061500001201030000" {
        Ok("БТР, МТЛБ".to_string())
    } else if app6d == "10062500002812000000" {
        Ok("ВОП, РОП".to_string())
    } else if app6d == "10061000001303010000" {
        Ok("САУ".to_string())
    } else if app6d == "10061500001116020000" {
        Ok("РСЗВ".to_string())
    } else if app6d == "10062500001602020000" {
        Ok("СП".to_string())
    } else if app6d == "10062500001602050000" {
        Ok("ІФО".to_string())
    } else if app6d == "10064000001106000000" {
        Ok("Артилерійський обстріл".to_string())
    } else if app6d == "10064000001600000000" {
        Ok("Накати гусеничної техніки".to_string())
    } else if app6d == "10062000001120000000" {
        Ok("Склад / сховище".to_string())
    } else if app6d == "10051500001601000000" {
        Ok("Легковий автомобіль".to_string())
    } else if app6d == "10062500002501000000" {
        Ok("Вогнева позиція артилерії".to_string())
    } else if app6d == "10061500001201050000" {
        Ok("Бронеавтомобіль".to_string())
    } else if app6d == "10061500001602010000" {
        Ok("Пікап".to_string())
    } else if app6d == "10062000001200000000" {
        Ok("Будівля".to_string())
    } else if app6d == "10062500001303000000" {
        Ok("Блокпост".to_string())
    } else if app6d == "10062500002803000000" {
        Ok("Протитанкове мінне загородження".to_string())
    } else if app6d == "10062000001212030000" {
        Ok("Телекомунікаційна вежа".to_string())
    } else if app6d == "10062000001107010000" {
        Ok("Міст".to_string())
    } else if app6d == "10064000001100000000" {
        Ok("Подія".to_string())
    } else if app6d == "10061500002013000000" {
        Ok("Намет".to_string())
    } else if app6d == "10061500002103000000" {
        Ok("Протитанкова міна".to_string())
    } else if app6d == "10061500001604020000" {
        Ok("Мікроавтобус".to_string())
    } else if app6d == "10062500002171000000" {
        Ok("Загальний маршрут".to_string())
    } else if app6d == "10061500001409000000" {
        Ok("Паливозаправник".to_string())
    } else if app6d == "10061500001314000000" {
        Ok("Екскаватор".to_string())
    } else if app6d == "10061500001603020000" {
        Ok("Мікроавтобус".to_string())
    } else if app6d == "10061540001202020000" {
        Ok("Танк".to_string())
    } else if app6d == "10061540001201010000" {
        Ok("ББМ".to_string())
    } else if app6d == "10062000001103000000" {
        Ok("Склад боєприпасів".to_string())
    } else if app6d == "10061500001109020000" {
        Ok("Буксована артилерія".to_string())
    } else if app6d == "10061000000000000000" {
        Ok("Інша бойова група".to_string())
    } else if app6d == "10062500002502000000" {
        Ok("Капонір".to_string())
    } else if app6d == "10061540001201030000" {
        Ok("БТР, МТЛБ".to_string())
    } else if app6d == "10061530001408000000" {
        Ok("ВАТ".to_string())
    } else if app6d == "10061530001202020000" {
        Ok("Танк".to_string())
    } else if app6d == "10061530001201010000" {
        Ok("ББМ".to_string())
    } else if app6d == "10061000001505040000" {
        Ok("РЕБ".to_string())
    } else if app6d == "10062500002810000000" {
        Ok("ДОТ".to_string())
    } else if app6d == "10061540001408000000" {
        Ok("ВАТ".to_string())
    } else if app6d == "10061500001109030000" {
        Ok("САУ".to_string())
    } else if app6d == "10051500001605020000" {
        Ok("Джип".to_string())
    } else if app6d == "10001000001211000000" {
        Ok("о/с".to_string())
    } else if app6d == "10002000000000000000" {
        Ok("Казарма".to_string())
    } else if app6d == "10061500001605000000" {
        Ok("Джип".to_string())
    } else if app6d == "10061500001116030000" {
        Ok("РСЗВ".to_string())
    } else if app6d == "10062040001107010000" {
        Ok("Міст".to_string())
    } else if app6d == "10001500001601000000" {
        Ok("Легковий автомобіль".to_string())
    } else if app6d == "10052000000000000000" {
        Ok("Казарма".to_string())
    } else if app6d == "10061500001114020000" {
        Ok("Міномет".to_string())
    } else if app6d == "10060100001102000000" {
        Ok("Гелікоптер".to_string())
    } else if app6d == "10060100001101020000" {
        Ok("Бомбардувальники / штурмовики".to_string())
    } else if app6d == "10061500002001000000" {
        Ok("Антени".to_string())
    } else if app6d == "10060100001103000000" {
        Ok("БПЛА".to_string())
    } else if app6d == "10062700000000000000" {
        Ok("о/с".to_string())
    } else if app6d == "10031540001201030000" {
        Ok("ББМ".to_string())
    } else if app6d == "10062000001205000000" {
        Ok("Обʼєкт енергетики".to_string())
    // } else if app6d == "10061500001401000000" {
    //     Ok("".to_string())
    // } else if app6d == "10062500002802010000" {
    //     Ok("".to_string())
    // } else if app6d == "10051100001104000000" {
    //     Ok("".to_string())
    // } else if app6d == "10061000001101000000" {
    //     Ok("".to_string())
    // } else if app6d == "10061500001311000000" {
    //     Ok("".to_string())
    // } else if app6d == "10011500001601000000" {
    //     Ok("".to_string())
    // } else if app6d == "10062500003203000000" {
    //     Ok("".to_string())
    // } else if app6d == "10061000001511000000" {
    //     Ok("".to_string())
    // } else if app6d == "10061500001605030000" {
    //     Ok("".to_string())
    // } else if app6d == "10060100001101190000" {
    //     Ok("".to_string())
    } else if app6d == "10061500001604030000" {
        Ok("Автокран".to_string())
    // } else if app6d == "10061530001201030000" {
    //     Ok("".to_string())
    // } else if app6d == "10062000001208010000" {
    //     Ok("".to_string())
    // } else if app6d == "10061500001111040000" {
    //     Ok("".to_string())
    // } else if app6d == "10051500001408000000" {
    //     Ok("".to_string())
    // } else if app6d == "10064000001605000000" {
    //     Ok("".to_string())
    // } else if app6d == "10061500001502000000" {
    //     Ok("".to_string())
    // } else if app6d == "10051500001600000000" {
    //     Ok("".to_string())
    // } else if app6d == "10062030001120000000" {
    //     Ok("".to_string())
    } else if app6d == "10061500001412000000" {
        Ok("Евакуатор".to_string())
    // } else if app6d == "10061500001605010000" {
    //     Ok("".to_string())
    // } else if app6d == "10061500001315000000" {
    //     Ok("".to_string())
    // } else if app6d == "10060100001101000000" {
    //     Ok("".to_string())
    // } else if app6d == "10061530001601000000" {
    //     Ok("".to_string())
    // } else if app6d == "10052700001101010000" {
    //     Ok("".to_string())
    // } else if app6d == "10061500001602000000" {
    //     Ok("".to_string())
    // } else if app6d == "10061000001105010000" {
    //     Ok("".to_string())
    } else if app6d == "10061500002201000000" {
        Ok("Сенсор".to_string())
    // } else if app6d == "10061500001603030000" {
    //     Ok("".to_string())
    // } else if app6d == "10061500001403000000" {
    //     Ok("".to_string())
    // } else if app6d == "10052000001120000000" {
    //     Ok("".to_string())
    // } else if app6d == "10061500001603010000" {
    //     Ok("".to_string())
    } else if app6d == "10064000001402000000" {
        Ok("Дим".to_string())
    // } else if app6d == "10061530001605020000" {
    //     Ok("".to_string())
    // } else if app6d == "10061500001301000000" {
    //     Ok("".to_string())
    // } else if app6d == "10051500001603030000" {
    //     Ok("".to_string())
    // } else if app6d == "10061530001602010000" {
    //     Ok("".to_string())
    // } else if app6d == "10062040001212030000" {
    //     Ok("".to_string())
    // } else if app6d == "10061000001216000000" {
    //     Ok("".to_string())
    // } else if app6d == "10051500001604020000" {
    //     Ok("".to_string())
    // } else if app6d == "10061540001601000000" {
    //     Ok("".to_string())
    // } else if app6d == "10061500002203000000" {
    //     Ok("".to_string())
    // } else if app6d == "10061501001109020000" {
    //     Ok("".to_string())
    } else if app6d == "10061530001109020000" {
        Ok("Буксирована артилерія".to_string())
    } else if app6d == "10002500002811000000" {
        Ok("ІФО".to_string())
    } else if app6d == "10061000001512000000" {
        Ok("Сенсор".to_string())
    } else if app6d == "10062000001214070000" {
        Ok("Водонапорна вежа".to_string())
    } else if app6d == "10031500001605020000" {
        Ok("Джип".to_string())
    } else if app6d == "10061530001409000000" {
        Ok("Паливозаправник".to_string())
    } else if app6d == "10052000001200000000" {
        Ok("Інфраструктура".to_string())
    } else if app6d == "10061540001116030000" {
        Ok("РСЗО".to_string())
    } else if app6d == "10062040001103000000" {
        Ok("Склад БК".to_string())
    } else if app6d == "10061540001116020000" {
        Ok("РСЗО".to_string())
    } else if app6d == "10061040001303010000" {
        Ok("САУ".to_string())
    } else {
        println!("> warning: unknown app6d_to_category category: {app6d}");
        Ok("".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_weird_icons() {
        assert_eq!(
            convert_tsup_icon("files/БПЛА_дружній.png").unwrap(),
            "БПЛА_дружній.png".to_string()
        );
        assert_eq!(
            convert_tsup_icon("files/Медичний_підрозділ_дружній.png").unwrap(),
            "Медичний_підрозділ_дружній.png".to_string()
        );
        assert_eq!(
            convert_tsup_icon("files/Логістика, БК_01.png").unwrap(),
            "Логістика, БК.png".to_string()
        );
    }

    #[test]
    fn parse_app6d_01() {
        assert_eq!(
            parse_app6d("10032500001101010000").unwrap(),
            App6d {
                group1: "10".to_string(),
                context: "0".to_string(),
                identity: "3".to_string(),
                symbol_set: "25".to_string(),
                status: "0".to_string(),
                headquaters_or_task_force: "0".to_string(),
                echelon_or_mobility_or_towed_array: "00".to_string(),
                main_icon: "110101".to_string(),
                modifier1: "00".to_string(),
                modifier2: "00".to_string(),
            },
        );
    }
}
