use crate::error::AppError;
use crate::utils::m_cap_s;
use lazy_static::lazy_static;
use regex::Regex;

pub fn extract_location(inp: &str) -> Result<Option<String>, AppError> {
    if let Some(zp_peleng) =
        crate::rer_importer::zp_peleng_vorony_odina_format::parse(inp)
    {
        return Ok(Some(zp_peleng.location));
    }

    '_if: {
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r#"Локація: (?P<location>[^;\n]*);?"#).unwrap();
        }
        let Some(capts) = RE.captures(inp) else {
            break '_if;
        };
        let Some(location) = m_cap_s(&capts, "location") else {
            break '_if;
        };
        return Ok(Some(location));
    }
    '_if: {
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r#"Район: (?P<location>[^;\n]*);?"#).unwrap();
        }
        let Some(capts) = RE.captures(inp) else {
            break '_if;
        };
        let Some(location) = m_cap_s(&capts, "location") else {
            break '_if;
        };
        return Ok(Some(location));
    }
    let mut lines: Vec<String> = inp.lines().map(|x| x.to_string()).collect();
    lines = lines.iter().filter(|l| l.trim() != "").cloned().collect();
    lines.truncate(5);
    for line in lines.iter() {
        let line = line.to_string();
        let l = line.to_lowercase();
        if l.contains("управління")
            || l.contains("укх")
            || l.contains("мсб")
            || l.contains("омсбр")
            || l.contains("dmr")
        {
            '_if: {
                lazy_static! {
                    static ref RE: Regex = Regex::new(
                        r#"[^(]*\((?P<location>[а-яіїА-ЯІї]{1}[^)]*)\)?"#
                    )
                    .unwrap();
                }
                let Some(capts) = RE.captures(&line) else {
                    break '_if;
                };
                let Some(location) = m_cap_s(&capts, "location") else {
                    break '_if;
                };
                return Ok(Some(location.trim().to_string()));
            }
            '_if: {
                lazy_static! {
                    static ref RE: Regex =
                        Regex::new(r#"(?P<location>(?:[А-ЯІЇ]{5,}(?:\s+)?)+(?:(?:,\s*)?(?:-\s*)?(?:[А-ЯІЇ]{5,}(?:\s+)?)+)*)"#).unwrap();
                        // Regex::new(r#"(?P<location>(?=[А-ЯІЇ]{4})[А-ЯІЇ -]*)"#).unwrap();
                        // мій варінт і адаптований з ChatGPT

                }
                let Some(capts) = RE.captures(&line) else {
                    break '_if;
                };
                let Some(location) = m_cap_s(&capts, "location") else {
                    break '_if;
                };
                return Ok(Some(location.trim().to_string()));
            }
        }
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_location_mouse_01() {
        let body = r#"29.02.2024_15:50 F=446.1125(МГц) П54
УКХ р/м 70 мсп 42 мсд 58 А (СХ НОВОПРОКОПІВКА)
ЛАВИНА
СЕРБ
ОРЕНБУРГ
ВОЛГОГРАД
- (1) СЕРБ я ЛАВИНА дай мне ОРЕНБУРГА на связь  
- (2) -ЛАВИНА ... да сейчас!
- (1) -ОРЕНБУРГ на приёме 
- (2) -ОРЕНБУРГ вызови к себе пожалуйста МАРКА ИРТЫША  и САВУ  и до САВЫ собери всех к САВЕ я сейчас буду там , еду уже с этого населённика про который я тебе говорил  , сейчас переговорим !

47.4067019, 35.8642446"#;
        let res = extract_location(body).unwrap().unwrap();
        assert_eq!(res, "СХ НОВОПРОКОПІВКА")
    }

    #[test]
    fn extract_location_zp_peleng_vorony_odina_mgrs_format() {
        let body = "Пост Shark 4\n447.450   \nр-н. Шевченка   \n36T VS 89904 14667 \n01.07.2026 03:07:42";
        let res = extract_location(body).unwrap().unwrap();
        assert_eq!(res, "р-н. Шевченка")
    }

    #[test]
    fn extract_location_zp_peleng_vorony_odina_sk42_format() {
        let body = "Пост Танго-Ехо\n446.354\nР-н Таврія\nx:51-29637\ny:65-01850\n03:10 01.07.2026";
        let res = extract_location(body).unwrap().unwrap();
        assert_eq!(res, "Р-н Таврія")
    }

    #[test]
    fn extract_location_zp_digital_post_alt_format() {
        let body = "01.07.2026, 03:04:16\n167.3000 ЦФП55\nУКХ р/м   управління 3 пдб 299 пдп 98 ( ЩЕРБАКИ, МИРНЕ)";
        let res = extract_location(body).unwrap().unwrap();
        assert_eq!(res, "ЩЕРБАКИ, МИРНЕ")
    }

    #[test]
    fn extract_location_mouse_02() {
        let body = r#"
30.03.2023_20:50 F=420,4250(МГц)
управління мсб 60 омсбр 5 ЗА (МАКАРІВКА, НЕСКУЧНЕ)
МУЗЫКАНТ
НВ (НВ)
"- На 22-й скажите, что крестики-нолики - работают
- (НВ) Я на 420-й разговариваю, так что не переживай"
"#;
        let res = extract_location(body).unwrap().unwrap();
        assert_eq!(res, "МАКАРІВКА, НЕСКУЧНЕ".to_string())
    }

    #[test]
    fn extract_location_mouse_03() {
        let body = r#"
11.04.23 08:25:42> 11.04.23 07:38:02 460,3500 Остановись где нибудь я сейчас подеду к тебе и обясню как принял ? [Мережа: УКХ р/м управління 1 мсб 4 ВБ ВАСИЛІВКА]
"#;
        let res = extract_location(body).unwrap().unwrap();
        assert_eq!(res, "ВАСИЛІВКА")
    }

    #[test]
    fn extract_location_mouse_04() {
        let body =
            r#"УКХ р/м гсабатр гсадн 70 мсп 42 мсд 58 А (ТАРАСІВКА - ПОЛОГИ)"#;
        let res = extract_location(body).unwrap().unwrap();
        assert_eq!(res, r#"ТАРАСІВКА - ПОЛОГИ"#)
    }

    #[test]
    fn extract_location_mouse_05() {
        let body = r#"УКХ радіомережа невизначеного підрозділу в районі населених пунктів       БЛАГОДАТНЕ - УРОЖАЙНЕ   -если человека одного ос"#;
        let res = extract_location(body).unwrap().unwrap();
        assert_eq!(res, r#"БЛАГОДАТНЕ - УРОЖАЙНЕ"#)
    }

    #[test]
    fn extract_location_mouse_06() {
        let body = r#"30.05.23 13:11 \\ 438.500 УКХ р/м управління 5 сб 112 осп (131 сп) МР, 4 осб ТрО 110 омсбр (район н.п. Новодонецьке – Новомайорське		"#;
        let res = extract_location(body).unwrap().unwrap();
        assert_eq!(res, r#"район н.п. Новодонецьке – Новомайорське"#)
    }

    #[test]
    fn extract_location_buran_01() {
        let body = r#"Дата: 2024-02-21;  
Частота: 408.500;  
Локація: Авдіївка (йм. в напрямку Ласточкине);  
Підрозділ: УКХ р/м невизначеного підрозділу;  
Час: 17:28;  
Хто: Змей;  
Кому: Чёрный;  
Текст:  
- Чёрный я Змей ответь по керосину  
- ..  
- 3 мсб? правильно?;  
.  
Коментар: ( запит на зв'язок );"#;
        let res = extract_location(body).unwrap().unwrap();
        assert_eq!(res, "Авдіївка (йм. в напрямку Ласточкине)")
    }

    #[test]
    fn extract_location_buran_02() {
        let body = r#"Час: 16:47
Дата: 23.02.2024
Частота: 412.300
Район: Піски Первомайське Водяне;
Підрозділ: УКХ р/м невизначеного підрозділу
Абоненти:
Позивні:

- выйди на мотор

( Запит на звязок)"#;
        let res = extract_location(body).unwrap().unwrap();
        assert_eq!(res, "Піски Первомайське Водяне")
    }
}
