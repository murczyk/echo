use crate::error::AppError;
use crate::types::*;
use chrono::prelude::*;
use chrono_tz::Tz;
use lazy_static::lazy_static;
use regex::{Captures, Regex};

type ProcessorFn =
    fn(DateTime<Tz>, &Captures) -> Result<NaiveDateTime, AppError>;

/// Витягує дату та час з тіла повідомлення.
/// ***ВАЖЛИВО:*** при додаванні нових форматів дати та часу
/// потрібно також додати їх у rer_importer::body_noheader::extract_text для коректного виділення тіла повідомлення.
pub fn extract_datetime(
    lnow: DateTime<Tz>,
    body: &str,
) -> Result<Option<NaiveDateTime>, AppError> {
    lazy_static! {
        static ref REGEX_PATTERNS: Vec<(&'static str, ProcessorFn)> = vec![
            // Work with formats like DD.MM.YYYY_HH:MI
            (
                r"(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4})_(?P<hour>\d{2})\s*:(?P<minute>\d{2})",
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, false) },
            ),
            // Work with formats like DD.MM.YYYY, HH:MI:SS
            (
                r"(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4}), (?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})",
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, true) },
            ),
            // Work with formats like YYYY-MM-DD_HH:MI
            (
                r"(?P<year>\d{4})-(?P<mon>\d{2})-(?P<day>\d{2})_(?P<hour>\d{2})\s*:(?P<minute>\d{2})",
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, false) },
            ),
            // Work with formats like YYYY-MM-DDTHH:MI:SS
            (
                r"(?P<year>\d{4})-(?P<mon>\d{2})-(?P<day>\d{2})T(?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})",
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, true) },
            ),
            // Work with formats like YYYY_MM_DD HH-MI-SS
            (
                r"(?P<year>\d{4})_(?P<mon>\d{2})_(?P<day>\d{2}) (?P<hour>\d{2})-(?P<minute>\d{2})-(?P<second>\d{2})",
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, true) },
            ),
            // Work with formats like 17.11, 00:01:49
            (
                r"(?P<day>\d{2})\.(?P<mon>\d{2}),? (?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})",
                |lnow, capts| { parse_datetime(lnow, capts, false, true, true, true) },
            ),
            // Work with formats like Час: 20:09:41
            (
                r"Час: (?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})",
                |lnow, capts| { parse_datetime(lnow, capts, false, false, false, true) },
            ),
            // Work with formats like DD.MM.YYYY HH:MI:SS
            (
                r"(?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4}) (?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})",
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, true) },
            ),
            // Work with formats like HH:MI DD.MM.YYYY
            (
                r"(?P<hour>\d{2})\s*:(?P<minute>\d{2}) (?P<day>\d{2})\.(?P<mon>\d{2})\.(?P<year>\d{4})",
                |lnow, capts| { parse_datetime(lnow, capts, true, true, true, false) },
            ),
            (
                r"\s+(?P<hour>\d\d?)\s*:(?P<minute>\d{2})\s+",
                |lnow, capts| { parse_datetime(lnow, capts, false, false, false, false) },
            ),
            // Work with formats like 20-11 16:53:04
            (
                r"(?P<day>\d{2})-(?P<mon>\d{2}) (?P<hour>\d{2})\s*:(?P<minute>\d{2})\s*:(?P<second>\d{2})",
                |lnow, capts| { parse_datetime(lnow, capts, false, true, true, true) },
            ),
        ];
    }

    for (pattern, processor) in REGEX_PATTERNS.iter() {
        let regex = Regex::new(pattern).unwrap();
        if let Some(capts) = regex.captures(body) {
            match processor(lnow, &capts) {
                Ok(datetime) => return Ok(Some(datetime)),
                Err(_) => {
                    // println!("Error processing pattern {}: {:?}", pattern, e);
                    continue;
                }
            }
        }
    }

    // Special case
    // Work with formats like Дата: 2024-02-21; and Час: 17:28; in different lines
    lazy_static! {
        static ref RE_DATE_BURAN: Regex = Regex::new(
            r"Дата: (?P<year>\d\d\d\d)-(?P<mon>\d\d)-(?P<day>\d\d);?"
        )
        .unwrap();
        static ref RE_TIME_BURAN: Regex =
            Regex::new(r"Час: (?P<hour>\d\d):(?P<minute>\d\d);?").unwrap();
    }
    '_if: {
        if let (Some(capts_ymd), Some(capts_hm)) =
            (RE_DATE_BURAN.captures(body), RE_TIME_BURAN.captures(body))
        {
            let Some(day) = capts_ymd.name("day") else {
                break '_if;
            };
            let day: u32 = day.as_str().parse().c(h!())?;
            let Some(mon) = capts_ymd.name("mon") else {
                break '_if;
            };
            let mon: u32 = mon.as_str().parse().c(h!())?;
            let Some(year) = capts_ymd.name("year") else {
                break '_if;
            };
            let year: i32 = year.as_str().parse().c(h!())?;

            let Some(hour) = capts_hm.name("hour") else {
                break '_if;
            };
            let hour: u32 = hour.as_str().parse().c(h!())?;
            let Some(minute) = capts_hm.name("minute") else {
                break '_if;
            };
            let minute: u32 = minute.as_str().parse().c(h!())?;
            let Some(res) = NaiveDate::from_ymd_opt(year, mon, day) else {
                break '_if;
            };
            let Some(res) = res.and_hms_opt(hour, minute, 0) else {
                break '_if;
            };
            let mut res: NaiveDateTime = res;
            let Some(res_tz) =
                lnow.timezone().from_local_datetime(&res).earliest()
            else {
                break '_if;
            };
            if res_tz > lnow {
                res -= chrono::Duration::days(1);
            }
            let lmax = lnow + chrono::Duration::days(2);
            if res_tz > lmax {
                break '_if;
            }
            return Ok(Some(res));
        }
    };

    Ok(None)
}

fn parse_datetime(
    lnow: DateTime<Tz>,
    capts: &regex::Captures,
    has_year: bool,
    has_month: bool,
    has_day: bool,
    has_second: bool,
) -> Result<NaiveDateTime, AppError> {
    let mon: u32 = if has_month {
        capts["mon"].parse().c(h!())?
    } else {
        lnow.month()
    };
    let day: u32 = if has_day {
        capts["day"].parse().c(h!())?
    } else {
        lnow.day()
    };
    let hour: u32 = capts["hour"].parse().c(h!())?;
    let minute: u32 = capts["minute"].parse().c(h!())?;
    let second: u32 = if has_second {
        capts["second"].parse().c(h!())?
    } else {
        0
    };

    let year: i32 = if has_year {
        capts["year"].parse().c(h!())?
    } else {
        lnow.year()
    };

    let Some(res) = NaiveDate::from_ymd_opt(year, mon, day)
        .and_then(|d| d.and_hms_opt(hour, minute, second))
    else {
        return Err(AppError::BL {
            msg: "Invalid date or time".to_string(),
        });
    };

    let tz = lnow.timezone();
    let Some(mut res_tz) = tz.from_local_datetime(&res).earliest() else {
        return Err(AppError::BL {
            msg: "Invalid date or time".to_string(),
        });
    };

    if !has_month && !has_day {
        if res_tz > lnow {
            res_tz -= chrono::Duration::days(1);
        }
    }

    if !has_year {
        let current_diff = lnow - res_tz;
        if let Some(res_tz_prev_year) = res_tz.with_year(res_tz.year() - 1) {
            let prev_year_diff = lnow - res_tz_prev_year;
            // choose closer date if no year
            if prev_year_diff.abs() < current_diff.abs() {
                res_tz = res_tz_prev_year;
            }
        }
    }

    let lmax = lnow + chrono::Duration::days(2);
    if res_tz > lmax {
        return Err(AppError::BL {
            msg: "Date or time too far in future".to_string(),
        });
    }

    Ok(res_tz.naive_local())
}

/// Parses datetime string like "11 грудня 2023 19:46"
pub fn parse_delta_csv_dt(s: &str) -> Result<NaiveDateTime, AppError> {
    println!("s = {s}");
    let s = s
        .replace("січня", "01")
        .replace("лютого", "02")
        .replace("березня", "03")
        .replace("квітня", "04")
        .replace("травня", "05")
        .replace("червня", "06")
        .replace("липня", "07")
        .replace("серпня", "08")
        .replace("вересня", "09")
        .replace("жовтня", "10")
        .replace("листопада", "11")
        .replace("грудня", "12");
    let s = s
        .replace("january", "01")
        .replace("february", "02")
        .replace("march", "03")
        .replace("april", "04")
        .replace("may", "05")
        .replace("june", "06")
        .replace("july", "07")
        .replace("august", "08")
        .replace("september", "09")
        .replace("october", "10")
        .replace("november", "11")
        .replace("december", "12");
    println!("s = {s}");
    Ok(NaiveDateTime::parse_from_str(&s, "%d %m %Y %H:%M").c(h!())?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono_tz::Europe::Kyiv;

    #[test]
    fn extract_datetime_test01() {
        let input = r#"08.02.2023_21:00 F=455,5550(МГц)
 ()
НВ (НВ)
НВ (НВ)
"Назвать его Ебаньком он начал атаковать своих, ему пизда, тебе пизда, как принял прием? Принял тебя Заря, ты где сейчас?""#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2023, 2, 8)
                .unwrap()
                .and_hms_opt(21, 0, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test02() {
        let input = r#"17.11, 00:01:49
465.8250
УКХ р/м управління штурмової роти "Шторм Z" 136 омсбр 58 А 
НВ
НВ

1. Дойди до Ахиллеса, посмотри, может там батарейка села на рации.
2. Принял.
1. Ты видишь меня на дороге?"#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let year = Local::now().year();
        let expected = Some(
            NaiveDate::from_ymd_opt(year, 11, 17)
                .unwrap()
                .and_hms_opt(0, 1, 49)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_keeps_time() {
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let dt1: NaiveDateTime =
            extract_datetime(lnow, "16.02.2023_10:55").unwrap().unwrap();
        let dt2 = Kyiv.from_local_datetime(&dt1).unwrap();
        let expected: chrono::DateTime<chrono_tz::Tz> =
            Kyiv.with_ymd_and_hms(2023, 2, 16, 10, 55, 0).unwrap();
        assert_eq!(dt2, expected);
    }

    #[test]
    fn extract_datetime_test03() {
        let input = r#"2023-09-04_20:17:25 F=433.25(МГц)
 ()
НВ (НВ)
НВ (НВ)
"Назвать его Ебаньком он начал атаковать своих, ему пизда, тебе пизда, как принял прием? Принял тебя Заря, ты где сейчас?""#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2023, 9, 4)
                .unwrap()
                .and_hms_opt(20, 17, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test04() {
        let input = r#"17.11, 15:56:55
436.1000
УКХ НВ 436.100
НВ
НВ
47.4527, 35.77689

1. Там всё, две фары. Один вот, шуровый, чо жалеть...
"#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let year = Local::now().year();
        let expected = Some(
            NaiveDate::from_ymd_opt(year, 11, 17)
                .unwrap()
                .and_hms_opt(15, 56, 55)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test05() {
        let input = r#"⚠️19.11 11:54:51
402.3550
УКХ НВ
САМУРАЙ
СТУДЕНТ
- 1 Провёл небольшую ротацию. Провели разведку в окопе, где КОСА сидел, я проводил и КОСА, вдвоём. Посадил щас туда 10 человек
- 2 Ты им приборы дал?
- 1 Да, всё дал, похавать дал"#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let year = Local::now().year();
        let expected = Some(
            NaiveDate::from_ymd_opt(year, 11, 19)
                .unwrap()
                .and_hms_opt(11, 54, 51)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test06() {
        let input = r#"⚡⚡⚡ 417.750 - УКХ р/м управління 237 дшп 7 дшд (НОВОПРОКОПІВКА) /

Час: 20:09:41
1. Дом, я Лесник, понаблюдайте, там наши соседи фонарики какие-то наблюдают где-то, посмотрите обтановочку и доложите
"#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let tz = crate::config::get_tz();
        let now = Local::now().with_timezone(&tz);
        let dt = now;
        let dt = if now.hour() <= 20 {
            if now.hour() == 20 && now.minute() > 9 {
                dt
            } else {
                dt - chrono::Duration::days(1)
            }
        } else {
            dt
        };
        let expected = Some(
            NaiveDate::from_ymd_opt(dt.year(), dt.month(), dt.day())
                .unwrap()
                .and_hms_opt(20, 9, 41)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test07() {
        let input = r#"2023-11-06T05:14:54"#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2023, 11, 6)
                .unwrap()
                .and_hms_opt(5, 14, 54)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test08() {
        let input = r#"⚠️20.12, 13:45:21
430.000
УКХ р/м ймовірно 237 дшп
НВ
НВ

1 - Батарейки на Азарт заряжение все у вас ?
1 - Давай потихонечку начинай собирать
2 - Да принял да
1 - Через час полтора чтоб все било собрано что сидели на чемодане как понял
1 - Карандашей сколько
1 - ЛЕНКОР Я МОЛЧАН
1 - Через полтора часа все вещи собрании
1 - С первого раза что блять не понятно , не уходишь пока от туда не заберёшь АЗГАРДА и КАБАНА как принял
1 - По закону 20-ть дней как полагается
1 - Ти меня понял нет , это первая партия будет( . . .) выходить я хуй знает пойми короче , твоя задача встретить АЗГАРДА забрать и ЖОСТКОГО з собой , только тогда ти подходишь как меня понял прием
2 - Да я принял тогда я один остаюсь остальных отправляю"#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let year = Local::now().year();
        let expected = Some(
            NaiveDate::from_ymd_opt(year, 12, 20)
                .unwrap()
                .and_hms_opt(13, 45, 21)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test09() {
        let input = r#"2025_01_13 17-02-34
Частота: 274,750 MHz
Канал: Unknown
Напрямок: Суджа, Снагість, Обухівка

— второй 076 Спасибо за прикрытие счастья здоровья"#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2025, 1, 13)
                .unwrap()
                .and_hms_opt(17, 2, 34)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_test10() {
        let input = r#"24.07.2025, 08:05:21
149.7300
УКХ р/м 60 омсб "Сомалі" 9 омсбр (ЗАТИШОК - сх НОВЕ ШАХОВЕ)
ТРАКТОР
НВ

— Депутат, Депутат Трактору.
— Да, все живы, машине пизда."#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2025, 7, 24)
                .unwrap()
                .and_hms_opt(8, 5, 21)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_commintify_header_2025() {
        let input = r#"Отримано з поста "."
--------------------------------------
20.11.2025, 12:29:18
157.8750
УКХ р/м НВ підрозділу 157.875 МГц
НВ
НВ

— Первый раунд 4, Шапка 1."#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2025, 11, 20)
                .unwrap()
                .and_hms_opt(12, 29, 18)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_dash_date_keeps_seconds() {
        let input = r#"20-11 16:53:04
446.000
УКХ ймовірно, 344 мсп 69 мсд 6 А (МИКОЛАЇВКА-ЛИМАН ДРУГИЙ)
НВ
НВ

– Да, давай синьки.

Коментар: T2"#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let year = Local::now().year();
        let expected = Some(
            NaiveDate::from_ymd_opt(year, 11, 20)
                .unwrap()
                .and_hms_opt(16, 53, 4)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_full_date_space_time() {
        let input = r#"УКХ р/м управління підрозділу противника
ДОРОЗВІДКА
144.581 МГц

20.11.2025 16:56:01

Отримувач(і): ШУТ,
РЯБА
Відправник: НВ

1. Птицы лишние разогнали, если не слышите, блять, прям чухайте по-быстрому к саму дому, Комиком мы работаем.
1. ШУТ, РЯБА , как раз пока по тому дому, где пидары сидят, ебашит слоник, птицы ми разогнали лишние, если никого не слышите, гасите домой, гасите домой.
1. Давай, все у вас видим, давайте, пацаны, быстрее, быстрее, там далеко наша птица, висит другая, давайте быстрее."#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2025, 11, 20)
                .unwrap()
                .and_hms_opt(16, 56, 1)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_time_before_date() {
        let input = r#"11:37 29.11.2025
Пост: КВАНТ
Частота: 143.545
Напрямок: Пн. Дворічна
Координати (MGRS): 37U DR 03349 25624"#;
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2025, 11, 29)
                .unwrap()
                .and_hms_opt(11, 37, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_23feb24_1() {
        let input = r#"Дата: 2024-02-21;
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
        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2024, 2, 21)
                .unwrap()
                .and_hms_opt(17, 28, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_no_year_closest_past() {
        let input = r#"31.12, 19:31:34
446.000
УКХ ймовірно, 344 мсп 69 мсд 6 А (МИКОЛАЇВКА-ЛИМАН ДРУГИЙ)
НВ
НВ

– Да, давай синьки.

Коментар: T2"#;
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2025, 02, 01, 01, 15, 22).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2024, 12, 31)
                .unwrap()
                .and_hms_opt(19, 31, 34)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_no_year_closest_future() {
        let input = r#"31.12, 19:31:34
446.000
УКХ ймовірно, 344 мсп 69 мсд 6 А (МИКОЛАЇВКА-ЛИМАН ДРУГИЙ)
НВ
НВ

– Да, давай синьки.

Коментар: T2"#;
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2024, 12, 30, 01, 15, 22).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = Some(
            NaiveDate::from_ymd_opt(2024, 12, 31)
                .unwrap()
                .and_hms_opt(19, 31, 34)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_datetime_no_year_toofar_future() {
        let input = r#"31.12, 19:31:34
446.000
УКХ ймовірно, 344 мсп 69 мсд 6 А (МИКОЛАЇВКА-ЛИМАН ДРУГИЙ)
НВ
НВ

– Да, давай синьки.

Коментар: T2"#;
        let tz = crate::config::get_tz();
        let lnow = tz.with_ymd_and_hms(2024, 11, 01, 21, 15, 22).unwrap();
        let res = extract_datetime(lnow, input).unwrap();
        let expected = None;
        assert_eq!(res, expected);
    }

    #[ignore]
    #[test]
    fn extract_datetime_kharkiv() {
        let body = r#"УКХ р/м управління мінометної батареї зі складу 155 обр МП
( в районі СТРІЛЕЧА)
23:52	МАКИМАК	ЧЕРНЫЙ	444.363
1. Там как СОЧИ до тебя дотянуться, узнай у них обстановку, как, че, кто там остался, и выйдешь на меня.
2. да принял.
(Л)"#;

        let tz = crate::config::get_tz();
        let lnow = Local::now().with_timezone(&tz);
        let res = extract_datetime(lnow, body).unwrap();

        let dt = lnow;
        let dt = if lnow.hour() <= 20 {
            if lnow.hour() == 20 && lnow.minute() > 9 {
                dt
            } else {
                dt - chrono::Duration::days(1)
            }
        } else {
            dt
        };
        let expected = Some(
            NaiveDate::from_ymd_opt(dt.year(), dt.month(), dt.day())
                .unwrap()
                .and_hms_opt(23, 52, 0)
                .unwrap(),
        );
        assert_eq!(res, expected);
    }
}
