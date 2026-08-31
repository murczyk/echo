use itertools::Itertools;
use lazy_static::lazy_static;
use std::collections::{BTreeMap, BTreeSet};
use std::iter::{IntoIterator, Iterator};

#[derive(Clone, Debug, Copy, Ord, Eq, PartialOrd, PartialEq)]
pub enum UnitType {
    #[allow(clippy::upper_case_acronyms)]
    COMPANY = 1,
    #[allow(clippy::upper_case_acronyms)]
    BATTALION = 2,
    #[allow(clippy::upper_case_acronyms)]
    REGIMENT = 3,
    #[allow(clippy::upper_case_acronyms)]
    BRIGADE = 4,
    #[allow(clippy::upper_case_acronyms)]
    DIVISION = 5,
    #[allow(clippy::upper_case_acronyms)]
    CORPS = 6,
    #[allow(clippy::upper_case_acronyms)]
    ARMY = 7,
}

pub fn list_named_unit_names() -> &'static BTreeSet<String> {
    lazy_static! {
        static ref UNIQUE: BTreeSet<String> =
            collect_set(unique_unit_names_arr().into_iter().collect_vec());
    }
    &UNIQUE
}

pub fn list_standalone() -> &'static Vec<String> {
    lazy_static! {
        static ref STANDALONE: Vec<String> =
            collect_set(standalone_arr().into_iter().collect_vec())
                .into_iter()
                .map(|x| x.to_lowercase())
                .collect_vec();
    }
    &STANDALONE
}

pub fn list_companies() -> &'static BTreeSet<String> {
    lazy_static! {
        static ref COMPANIES: BTreeSet<String> =
            collect_set(companies_arr().into_iter().collect_vec());
    }
    &COMPANIES
}

pub fn list_regiments() -> &'static BTreeSet<String> {
    lazy_static! {
        static ref REGIMENTS: BTreeSet<String> = collect_set(
            regiments_arr()
                .into_iter()
                .filter(|name| !list_brigades().contains(&name.to_lowercase()))
                .collect_vec(),
        );
    }
    &REGIMENTS
}

pub fn list_brigades() -> &'static BTreeSet<String> {
    lazy_static! {
        static ref BRIGADES: BTreeSet<String> =
            collect_set(brigades_arr().into_iter().collect_vec());
    }
    &BRIGADES
}

pub fn list_divisions() -> &'static BTreeSet<String> {
    lazy_static! {
        static ref DIVISIONS: BTreeSet<String> =
            collect_set(divisions_arr().into_iter().collect_vec());
    }
    &DIVISIONS
}

pub fn list_armies() -> &'static BTreeSet<String> {
    lazy_static! {
        static ref ARMIES: BTreeSet<String> = collect_set(
            armies_arr()
                .into_iter()
                .filter(|name| !list_corps().contains(&name.to_lowercase()))
                .collect_vec(),
        );
    }
    &ARMIES
}

pub fn list_corps() -> &'static BTreeSet<String> {
    lazy_static! {
        static ref CORPS: BTreeSet<String> =
            collect_set(corps_arr().into_iter().collect_vec());
    }
    &CORPS
}

pub fn list_battalions() -> &'static BTreeSet<String> {
    lazy_static! {
        static ref BATTALIONS: BTreeSet<String> =
            collect_set(battalions_arr().into_iter().collect_vec());
    }
    &BATTALIONS
}

pub fn apply_unit_name_fixes(text: String) -> String {
    let mut text = text;
    for (old, new) in list_fixes() {
        if !text.contains(old) {
            continue;
        }

        let token = format!("{old} ");
        if text.starts_with(&token) {
            text = text.replace(&token, &format!("{new} "));
        }

        let token = format!(" {old} ");
        if text.contains(&token) {
            text = text.replace(&token, &format!(" {new} "));
        }

        let token = format!(" {old}");
        if text.ends_with(&token) {
            text = text.replace(&token, &format!(" {new}"));
        }
    }
    text
}

pub fn extract_named_units(text: String) -> (String, Vec<String>) {
    let mut text = text
        .replace("\"", "")
        .replace("“", "")
        .replace("”", "")
        .replace("«", "")
        .replace("»", "")
        .to_lowercase();
    let mut matches = vec![];
    for name in list_named_unit_names() {
        let nm = name.to_lowercase();
        if !text.contains(&nm) {
            continue;
        }

        if text.eq(&nm) {
            text = "".to_string();
            matches.push(name.clone());
            continue;
        }

        let token = format!("{} ", nm);
        if text.starts_with(&token) {
            text = text.replace(&token, "");
            matches.push(name.clone());
            continue;
        }

        let token = format!(" {} ", nm);
        if text.contains(&token) {
            text = text.replace(&token, "");
            matches.push(name.clone());
            continue;
        }

        let token = format!(" {}", nm);
        if text.ends_with(&token) {
            text = text.replace(&token, "");
            matches.push(name.clone());
        }
    }
    (text, matches)
}

fn list_fixes() -> &'static BTreeMap<String, String> {
    fn mk_fixes() -> BTreeMap<String, String> {
        let mut result = BTreeMap::new();
        result.insert("ц МТЗ".to_string(), "цМТЗ".to_string());
        result.insert("брз (тер)".to_string(), "брз".to_string());
        result.insert("абр БМ".to_string(), "абрБМ".to_string());
        result.insert("УВ (с)".to_string(), "УВ".to_string());
        result.insert("Центр БпЛА РУБИКОН".to_string(), "РУБИКОН".to_string());
        result
    }
    lazy_static! {
        static ref FIXES: BTreeMap<String, String> = mk_fixes();
    }
    &FIXES
}

fn companies_arr() -> [&'static str; 176] {
    [
        "автр",
        "авто",
        "автв",
        "взмр",
        "взор",
        "врлр",
        "вртр",
        "ву",
        "вуд",
        "вуна",
        "вунад",
        "рдо",
        "дро",
        "вдо",
        "рмо",
        "тхр",
        "вмо",
        "рмп",
        "вмп",
        "рсн",
        "вс",
        "ос",
        "рРХБЗ",
        "рхз",
        "вРХБЗ",
        "вхз",
        "вгпт",
        "огпт",
        "воб",
        "во",
        "врп",
        "врр",
        "всн",
        "осн",
        "всо",
        "взвавт",
        "воір",
        "взхз",
        "вр",
        "ор",
        "вто",
        "ото",
        "врхр",
        "орхр",
        "втае",
        "ве",
        "гв",
        "го",
        "гср",
        "гсв",
        "гсо",
        "дшр",
        "дшв",
        "дшз",
        "дшо",
        "заградеск",
        "заградотряд",
        "збпс",
        "зєнпулр",
        "зєнадн",
        "зєнав",
        "зрав",
        "зрв",
        "зро",
        "зорс",
        "зрр",
        "зсапр",
        "зсав",
        "іср",
        "ішр",
        "ішв",
        "ішо",
        "ісо",
        "ісв",
        "істротряд",
        "ітр",
        "кабшр",
        "кр",
        "кв",
        "кеск",
        "мєдр",
        "мєдв",
        "мєтв",
        "мінв",
        "мрае",
        "мєдсанр",
        "мєдсанвзв",
        "мєдсанеск",
        "мєдсандів",
        "мср",
        "мсв",
        "мсо",
        "мтае",
        "обтр",
        "огвзв",
        "оде",
        "огв",
        "ооспн",
        "ор",
        "ов",
        "оо",
        "оіо",
        "окае",
        "океск",
        "оор",
        "орнр",
        "осрс",
        "от",
        "орс",
        "ору",
        "орхз",
        "орвп",
        "орхр",
        "оес",
        "опес",
        "оехз",
        "ОпЕск",
        "пгв",
        "пдр",
        "пдв",
        "пдо",
        "пдєср",
        "погз",
        "погк",
        "пого",
        "понр",
        "понв",
        "пдо",
        "понтвєспарк",
        "птв",
        "пто",
        "пулар",
        "пулр",
        "пулвзв",
        "пулв",
        "пкг",
        "порєм",
        "ппг",
        "ппс",
        "пу",
        "рае",
        "раг",
        "рєзеск",
        "ррєг",
        "рр",
        "ро",
        "рв",
        "рвр",
        "ргсн",
        "рдр",
        "ртот",
        "рємр",
        "рємв",
        "рпк",
        "ррп",
        "рспн",
        "рспп",
        "сапр",
        "спе",
        "сае",
        "ср",
        "св",
        "со",
        "тр",
        "тв",
        "то",
        "тгв",
        "уаг",
        "УОС",
        "УІР",
        "УНР",
        "фгв",
        "хозв",
        "хозо",
        "штрафб",
        "шр",
    ]
}

fn regiments_arr() -> [&'static str; 133] {
    [
        "аап",
        "абр",
        "ап",
        "абр",
        "бап",
        "брдк",
        "бріз",
        "брмо",
        "брмп",
        "вб",
        "пмп",
        "брсн",
        "бр",
        "брс",
        "пс",
        "брп",
        "бру",
        "бро",
        "брз",
        "брк",
        "брпск",
        "брхз",
        "брРХБЗ",
        "вдбр",
        "втап",
        "габр",
        "гап",
        "гсп",
        "дкбр",
        "дршбр",
        "дшбр",
        "дшп",
        "ждбр",
        "зап",
        "зєнап",
        "зрбр",
        "зрп",
        "зпбєпо",
        "іап",
        "ісбр",
        "ісп",
        "ібрсн",
        "смбр",
        "імбр",
        "іптабр",
        "ітп",
        "кабр",
        "кап",
        "кіап",
        "кбр",
        "кп",
        "гкп",
        "лабр",
        "лап",
        "лабр",
        "лбр",
        "мєхп",
        "мвдбр",
        "мп",
        "мєхбр",
        "мбр",
        "мібр",
        "мінп",
        "мінп",
        "мрап",
        "мббр",
        "морсбр",
        "мрап",
        "мсбр",
        "мсп",
        "мтап",
        "мцп",
        "мпмп",
        "мпомп",
        "мшісбр",
        "обвп",
        "омбр",
        "омсбр",
        "овп",
        "оібр",
        "отбвп",
        "оллбр",
        "обрспн",
        "обрспп",
        "обрбпс",
        "опрос",
        "п",
        "пабр",
        "пап",
        "пдп",
        "понмбр",
        "поп",
        "помп",
        "птабр",
        "птап",
        "пулабр",
        "пулап",
        "псп",
        "рп",
        "раап",
        "рап",
        "рабр",
        "рбр",
        "рєабр",
        "реабр",
        "рєап",
        "ртбр",
        "сабр",
        "сап",
        "самп",
        "санап",
        "сапбр",
        "сапп",
        "свкп",
        "сводрєзп",
        "сбр",
        "сп",
        "тбр",
        "трб", // Техническая ракетная база (ТРБ) — часть специальных войск ракетной дивизии, предназначена для поддержания технической готовности ракетных комплексов
        "тп",
        "ттп",
        "тбап",
        "тгабр",
        "тгап",
        "тпбр",
        "тмінбр",
        "тсап",
        "тсп",
        "утап",
        "утбр",
        "учп",
        "шап",
        "шісбр",
    ]
}

fn brigades_arr() -> [&'static str; 68] {
    [
        "абр",
        "брдк",
        "бріз",
        "брмо",
        "брмп",
        "брсн",
        "бр",
        "брс",
        "брп",
        "бру",
        "бро",
        "брз",
        "брк",
        "брпск",
        "брхз",
        "брРХБЗ",
        "вдбр",
        "габр",
        "дкбр",
        "дршбр",
        "дшбр",
        "ждбр",
        "зрбр",
        "ісбр",
        "ібрсн",
        "смбр",
        "імбр",
        "іптабр",
        "кабр",
        "кбр",
        "лабр",
        "лбр",
        "мвдбр",
        "мєхбр",
        "мбр",
        "мібр",
        "мббр",
        "морсбр",
        "мсбр",
        "мшісбр",
        "омбр",
        "омсбр",
        "оібр",
        "оллбр",
        "обрспн",
        "обрспп",
        "обрбпс",
        "пабр",
        "понмбр",
        "птабр",
        "пулабр",
        "рабр",
        "рбр",
        "рєабр",
        "реабр",
        "ртбр",
        "сабр",
        "сапбр",
        "сбр",
        "тбр",
        "тгабр",
        "тпбр",
        "тмінбр",
        "утбр",
        "шісбр",
        "абр",
        "лабр",
        "лабр",
    ]
}
fn divisions_arr() -> [&'static str; 45] {
    [
        "ад",
        "адн",
        "бад",
        "вдд",
        "пдд",
        "втад",
        "гсд",
        "дбо",
        "дмп",
        "днк",
        "дпл",
        "дПВО",
        "дрк",
        "дірк",
        "дшд",
        "зєнад",
        "зрд",
        "зсд",
        "іад",
        "кд",
        "гкд",
        "кд",
        "крц",
        "мєхд",
        "мд",
        "мрад",
        "мсд",
        "мтад",
        "нбад",
        "нббад",
        "нтбад",
        "оброп",
        "опзаб",
        "пулад",
        "рд",
        "сад",
        "сд",
        "тд",
        "тад",
        "ттд",
        "тбад",
        "тпад",
        "ц МТЗ",
        "цМТЗ",
        "шад",
    ]
}
fn armies_arr() -> [&'static str; 32] {
    [
        "А",
        "ЗВА",
        "ак",
        "армія",
        "армії",
        "арм",
        "АК",
        "артк",
        "бак",
        "ВА",
        "ЗА",
        "вдк",
        "гск",
        "КПВО",
        "ЖДК",
        "іак",
        "кк",
        "МєхА",
        "мєхк",
        "бак",
        "Отд. А",
        "орк",
        "РА",
        "ск",
        "ТА",
        "УА",
        "шак",
        "ОВА",
        "ОВДА",
        "фсб",
        "фсб рф",
        "Фл",
    ]
}

fn corps_arr() -> [&'static str; 15] {
    [
        "ак", "АК", "артк", "бак", "вдк", "гск", "КПВО", "ЖДК", "іак", "кк",
        "мєхк", "бак", "орк", "ск", "шак",
    ]
}

fn battalions_arr() -> [&'static str; 111] {
    [
        "автобат",
        "бар",
        "бзрлр",
        "батр",
        "батрзмр",
        "бзр",
        "батрор",
        "батррлр",
        "батрртр",
        "батру",
        "бу",
        "батруар",
        "буіар",
        "батрПТУР",
        "бПТУР",
        "батрПТРК",
        "ббпла",
        "бдо",
        "бмо",
        "бмп",
        "бсн",
        "бс",
        "бРХБЗ",
        "бхз",
        "стройбат",
        "габатр",
        "гсб",
        "дкб",
        "дшб",
        "дшбу",
        "ждб",
        "об",
        "обон",
        "жєлдорбат",
        "зобс",
        "адн",
        "гадн",
        "гсадн",
        "зєнабатр",
        "зрабатр",
        "зраб",
        "зрб",
        "зсб",
        "зрадн",
        "зрдн",
        "зоіптд",
        "ісб",
        "оісб",
        "ітб",
        "кад",
        "лб",
        "ліб",
        "МБА",
        "мєдб",
        "мєтбатр",
        "міб",
        "мінбр",
        "міндн",
        "мінбатр",
        "мінб",
        "мінбат",
        "мєдсанбат",
        "мсб",
        "мпмб",
        "мпомб",
        "мцб",
        "од ПВО",
        "оіптб",
        "оіптд",
        "окад",
        "омд",
        "оптб",
        "орад",
        "озспп",
        "озспн",
        "осб",
        "падн",
        "пабатр",
        "пдб",
        "понб",
        "помб",
        "птадн",
        "птабатр",
        "пулаб",
        "пулб",
        "прб",
        "раадн",
        "рб",
        "рдн",
        "рвб",
        "рємбат",
        "рєадн",
        "рєбатр",
        "ртб",
        "садн",
        "сабатр",
        "сапб",
        "сбатр",
        "сб",
        "сміндн",
        "смінбатр",
        "тб",
        "тгбатр",
        "тдн",
        "тєхбатр",
        "тпб",
        "учад",
        "учб",
        "учд",
        "фгбатр",
        "одбп",
    ]
}

fn standalone_arr() -> [&'static str; 30] {
    [
        "ВМФ",
        "КаФл",
        "ДК",
        "ТРВ",
        "ПВО",
        "ППО",
        "ВДВ",
        "ПДВ",
        "ПКС",
        "ШТОРМ.ОСЕТИЯ",
        "Шторм Z",
        "Шторм V",
        "РУБИКОН",
        "РХБЗ",
        r"БАРС(-\d{1,2})?",
        "БАРС-И",
        "БАРС-БРЯНСК",
        "ЛВО",   // ленінградський воєнний округ
        "МВО",   // московський воєнний округ
        "ЦВО",   // центральний воєнний округ
        "ЮВО",   // южний воєнний округ
        "ВВО",   // восточний воєнний округ
        "фсвнг", // Національна гвардія рф
        "ОБТФ",  //днр
        "УВ Запад",
        "УВ Север",
        "УВ Сєвєр",
        "УВ Белгород",
        "УВ Бєлгород",
        "УВ Харків",
    ]
}

fn unique_unit_names_arr() -> [&'static str; 15] {
    [
        "ВОЛКИ",
        "Днепр",
        "Эспаньола",
        "дшрг Русич",
        "оршз Клуни",
        "Бастион",
        "Святой Георгий",
        "Ветераны",
        "ДРО Алания",
        "РЫСЬ РЕДУТ",
        "Восток V",
        "оршз Буран",
        "Русь",
        "Великий князь Владимир",
        "Батя-Ахмат",
    ]
}

fn collect_set(data: Vec<&str>) -> BTreeSet<String> {
    BTreeSet::from_iter(
        data.into_iter().map(|s| String::from(s).to_lowercase()),
    )
}
