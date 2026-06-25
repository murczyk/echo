use core::f64;

use crate::error::AppError;
use crate::utils::*;
use lazy_static::lazy_static;
use regex::Regex;

pub fn extract_freq(body: &str) -> Result<Option<String>, AppError> {
    // crazy and stupid NITRO format like "Частота: 449.500.000"
    '_if: {
        lazy_static! {
            static ref RE: Regex = Regex::new(
                r"Частота: (?P<freq_a>\d+)\.(?P<freq_b>\d+)\.(?P<freq_c>\d+)"
            )
            .unwrap();
        }
        if let Some(capts) = RE.captures(body) {
            let Some(part_a) = m_cap_s(&capts, "freq_a") else {
                break '_if;
            };
            let Some(part_b) = m_cap_s(&capts, "freq_b") else {
                break '_if;
            };
            let Some(part_c) = m_cap_s(&capts, "freq_c") else {
                break '_if;
            };
            return Ok(Some(etalon(&format!("{part_a}.{part_b}{part_c}"))));
        }
    }
    '_if: {
        lazy_static! {
            static ref RE: Regex = Regex::new(
                r"(?P<freq_a>\d+)(,|\.)(?P<freq_b>\d+)(\s?)(\(МГц\)|MHz)"
            )
            .unwrap();
        }
        if let Some(capts) = RE.captures(body) {
            let Some(part_a) = m_cap_s(&capts, "freq_a") else {
                break '_if;
            };
            let Some(part_b) = m_cap_s(&capts, "freq_b") else {
                break '_if;
            };
            return Ok(Some(etalon(&format!("{part_a}.{part_b}"))));
        }
    }
    '_if: {
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"(?P<freq_a>\d\d\d)(,|\.)(?P<freq_b>\d\d\d?\d?)")
                    .unwrap();
        }
        for capts in RE.captures_iter(body) {
            let Some(mut val_a) = m_cap_s(&capts, "freq_a") else {
                continue;
            };
            let Ok(a) = val_a.parse::<u64>() else {
                break '_if;
            };
            let Some(b) = m_cap_s(&capts, "freq_b") else {
                continue;
            };
            let main_band = (100..999).contains(&a);
            // let special_1 = a == 900;
            // let special_2 = a == 700;
            let special_3 = a == 0;
            if special_3 {
                val_a = String::from("000");
            }
            if main_band || special_3 {
                return Ok(Some(etalon(&format!("{val_a}.{b}"))));
            } else {
                continue;
            }
        }
    }
    Ok(None)
}

pub fn etalon(freq: &str) -> String {
    '_if: {
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"(?P<freq_a>\d+)\.(?P<freq_b>\d+)").unwrap();
        }
        if let Some(capts) = RE.captures(freq) {
            let Some(part_a) = m_cap_s(&capts, "freq_a") else {
                break '_if;
            };
            let Some(part_b) = m_cap_s(&capts, "freq_b") else {
                break '_if;
            };
            let mut part_b = part_b.chars().take(4).collect::<String>();
            while part_b.chars().count() < 4 {
                part_b.push('0');
            }
            return format!("{part_a}.{part_b}");
        }
    }
    freq.to_string()
}

pub fn round_to_nearest_005(input: String) -> String {
    format!(
        "{:.4}",
        (input.as_str().parse::<f64>().unwrap() / 0.005).round() * 0.005
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_freq_test01() {
        let input = r#"08.02.2023_21:00 F=455,5550(МГц)
 ()
НВ (НВ)
НВ (НВ)
"Назвать его Ебаньком он начал атаковать своих, ему пизда, тебе пизда, как принял прием? Принял тебя Заря, ты где сейчас?""#;
        let res = extract_freq(input).unwrap();
        let expected = Some("455.5550".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_test02() {
        let input = r#"08.02.2023_21:00 F=455.5550(МГц)"#;
        let res = extract_freq(input).unwrap();
        let expected = Some("455.5550".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_test03() {
        let input = "08.02.2023_21:00\nF=455.5550(МГц)";
        let res = extract_freq(input).unwrap();
        let expected = Some("455.5550".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_test04() {
        let input = "145.55\n47.392477\n36.056984\n10-11";
        let res = extract_freq(input).unwrap();
        let expected = Some("145.5500".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_test05() {
        let input = "145.5524\n47.392477\n36.056984\n10-11";
        let res = extract_freq(input).unwrap();
        let expected = Some("145.5524".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn etalon_pads_frequency_to_four_fraction_digits() {
        assert_eq!(etalon("123.45"), "123.4500");
    }

    #[test]
    fn etalon_truncates_frequency_to_four_fraction_digits() {
        assert_eq!(etalon("123.45678"), "123.4567");
    }

    #[test]
    fn extract_freq_test06() {
        let input = r#"13.11, 21:37:12
446.0375
УКХ р/м НВ підрозділу 446.0375 МГц
НВ
НВ"#;
        let res = extract_freq(input).unwrap();
        let expected = Some("446.0375".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_test07() {
        let input = r#"⚠️20.11, 00:39:28
446.0375
446.037 МГц;      16.11.2023 15:55:21   47,3547;  35,7935;      Нове  (на позивний Пума)
НВ
НВ

— Уфа, Уфа, я Пума. Уфа, на приеме. Уфа, на приеме по твоим тридцатам. Пума, я Уфа. Четверо легких пришли, по тяжелому пока не понятно, группа не выходит еще на связь. Либо та, сейчас либо, на семь с первой точки еще. А дел бомбита, спроси, что там на?"#;
        let res = extract_freq(input).unwrap();
        let expected = Some("446.0375".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_23feb24_1() {
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
        let res = extract_freq(input).unwrap();
        let expected = Some("408.5000".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_23feb24_2() {
        let input = r#"2024.02.23
18:32:00
432.0150
НОВОДОНЕЦЬКЕ
УКХ радіомережа йм 4 сб 116 осп


Филин,Лопата

- Лопата прием я Филин
- 5-ть минут да?
- 5-10 и все потом по команде если что
- Плюс

(вказівка скільки ще працювати )"#;
        let res = extract_freq(input).unwrap();
        let expected = Some("432.0150".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_23feb24_3() {
        let input = r#"2024.02.23
19:15:00
455.2750
ЄГОРІВКА- ШЕВЧЕНКО-ПЕТРІВСЬКЕ-ЄВГЕНІВКА
УКХ радіомережа управління зрадн йм. 40 обрмп

- Я говорю коробочку запустили запустили вас надо отвозить вопросительный?
- Надо
- Когда готовы будете?
- .. как принял прием
- Плюс

(запит чи треба відвозити о/с)
"#;
        let res = extract_freq(input).unwrap();
        let expected = Some("455.2750".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_nitro_1() {
        let input = r#"
Частота: 449.500.000
"#;
        let res = extract_freq(input).unwrap();
        let expected = Some("449.5000".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_nitro_2() {
        let input = r#"
Частота: 449.034.500
"#;
        let res = extract_freq(input).unwrap();
        let expected = Some("449.0345".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_antenna_name_with_mhz() {
        let input = "Тип: Антена\nНазва: 141.715 МГц\n24.06.2026 17:32\nКоординати: 36U XB 66512 50880";
        let res = extract_freq(input).unwrap();
        let expected = Some("141.7150".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_bare_frequency_line() {
        let input =
            "24.06.2026, 15:47:37\n138.0000\nУКХ р/м 2 мсб 121 мсп 68 мсд 6 А";
        let res = extract_freq(input).unwrap();
        let expected = Some("138.0000".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_11mar24_bug() {
        let input = r#"08.03, 18:07:55
416.5200 п65
УКХ р/м управління йм. 1 мсб 71 мсп 42 мсд 58 А (НОВОПРОКОПІВКА);
ОРДА
МЕДВЕДЬ

— Увидели пидарасов, опознали пидарасов, открывайте по ним огонь 
— Медведь я Орда, что там горит?
— Я как понял, это были игрушки для Скабаря и Танкиста. Ой, пакеты для Скабаря и Танкиста.
— Блядь, Медведь ты слышал?"#;
        let res = extract_freq(input).unwrap();
        let expected = Some("416.5200".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_aviation_01() {
        let input = r#"08.03, 12:35:23
120.3500
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        let expected = Some("120.3500".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_01() {
        let input = r#"08.03, 12:35:23
000.0004
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        let expected = Some("000.0004".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_02() {
        let input = r#"08.03, 12:35:23
900.0005
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        let expected = Some("900.0005".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_03() {
        let input = r#"08.03, 12:35:23
900.0006
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        let expected = Some("900.0006".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_04() {
        let input = r#"08.03, 12:35:23
700.0001
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        let expected = Some("700.0001".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_05() {
        let input = r#"08.03, 12:35:23
000.012
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        let expected = Some("000.0120".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_06() {
        let input = r#"08.03, 12:35:23
700.009
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        let expected = Some("700.0090".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_07() {
        let input = r#"08.03, 12:35:23
000.12
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        let expected = Some("000.1200".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_08() {
        let input = r#"08.03, 12:35:23
900.01
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        let expected = Some("900.0100".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_09() {
        let input = r#"08.03, 12:35:23
600.010
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        let expected = Some("600.0100".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_10() {
        let input = r#"08.03, 12:35:23
800.0100
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        let expected = Some("800.0100".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_11() {
        let input = r#"2025_01_13 17-02-34
Частота: 274,750 MHz
Канал: Unknown
Напрямок: Суджа, Снагість, Обухівка

— второй 076 Спасибо за прикрытие счастья здоровья"#;
        let res = extract_freq(input).unwrap();
        let expected = Some("274.7500".to_string());
        assert_eq!(res, expected);
    }

    #[test]
    fn extract_freq_special_12() {
        let input = r#"08.03, 12:35:23
95.6100
УКХ р/м бойового управління польотами авіації в зоні відповідальності 338 ртп
ХИТМАН
НВ

— 5 минут 4, ХИТМАН окончание."#;
        let res = extract_freq(input).unwrap();
        assert_eq!(res, None);
    }

    #[test]
    fn extract_freq_special_13() {
        let input = r#"96.5200 п65
УКХ р/м управління йм. 1 мсб 71 мсп 42 мсд 58 А (НОВОПРОКОПІВКА);
ОРДА
МЕДВЕДЬ

— Увидели пидарасов, опознали пидарасов, открывайте по ним огонь 
— Медведь я Орда, что там горит?
— Я как понял, это были игрушки для Скабаря и Танкиста. Ой, пакеты для Скабаря и Танкиста.
— Блядь, Медведь ты слышал?"#;
        let res = extract_freq(input).unwrap();
        assert_eq!(res, None);
    }

    #[test]
    fn extract_freq_special_14() {
        let input = r#"2024.02.23
19:15:00
1055.2750
ЄГОРІВКА- ШЕВЧЕНКО-ПЕТРІВСЬКЕ-ЄВГЕНІВКА
УКХ радіомережа управління зрадн йм. 40 обрмп

- Я говорю коробочку запустили запустили вас надо отвозить вопросительный?
- Надо
- Когда готовы будете?
- .. как принял прием
- Плюс

(запит чи треба відвозити о/с)"#;
        let res = extract_freq(input).unwrap();
        assert_eq!(res, None);
    }

    #[test]
    fn extract_etalon_01() {
        let body = "047.5750";
        let res = etalon(body);
        assert_eq!(res, "047.5750")
    }

    #[test]
    fn extract_etalon_02() {
        let body = "047.575";
        let res = etalon(body);
        assert_eq!(res, "047.5750")
    }

    #[test]
    fn extract_etalon_03() {
        let body = "047.57";
        let res = etalon(body);
        assert_eq!(res, "047.5700")
    }

    #[test]
    fn extract_etalon_04() {
        let body = "047.5";
        let res = etalon(body);
        assert_eq!(res, "047.5000")
    }

    #[test]
    fn extract_etalon_05() {
        let body = "137.15000";
        let res = etalon(body);
        assert_eq!(res, "137.1500")
    }

    #[test]
    fn extract_etalon_06() {
        let body = "445.44";
        let res = etalon(body);
        assert_eq!(res, "445.4400")
    }

    #[test]
    fn extract_etalon_07() {
        let body = "446.0375";
        let res = etalon(body);
        assert_eq!(res, "446.0375")
    }
    #[test]
    fn extract_etalon_08() {
        let body = "446.037";
        let res = etalon(body);
        assert_eq!(res, "446.0370")
    }
}
