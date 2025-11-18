use crate::error::AppError;
use crate::utils::m_cap_s;
use lazy_static::lazy_static;
use regex::Regex;

pub fn extract_post(inp: &str) -> Result<Option<String>, AppError> {
    let mut transit_post = None;
    // Only inspect the first N lines to avoid false positives deep in dialogues
    let scan_inp = inp
        .lines()
        .take(crate::config::POSTS_MAX_LINES)
        .collect::<Vec<_>>()
        .join("\n");

    // Extract transit_post_name if message has Отримано з поста "transit_post_name" substring.
    // But continue scan to find original post name
    // Return transit_post_name only if nothing else found
    '_if: {
        lazy_static! {
            static ref RE: Regex = Regex::new(
                r#"Отримано з поста "(?P<post>[a-zA-Zа-яіїА-ЯІЇ0-9)(_/ \.\-\*]+)""#
            )
            .unwrap();
        }
        let Some(capts) = RE.captures(&scan_inp) else {
            break '_if;
        };
        let Some(post) = m_cap_s(&capts, "post") else {
            break '_if;
        };
        transit_post = Some(post.to_string());
    }

    // Extract transit_post_name for unquoted form: Отримано з поста <name>
    // Keep scanning afterwards to find a more specific original post name, if present
    '_if: {
        lazy_static! {
            static ref RE: Regex = Regex::new(
                r#"Отримано з поста (?P<post>[a-zA-Zа-яіїА-ЯІЇ0-9)(_/ \.\-]+)"#
            )
            .unwrap();
        }
        let Some(capts) = RE.captures(&scan_inp) else {
            break '_if;
        };
        let Some(post) = m_cap_s(&capts, "post") else {
            break '_if;
        };
        transit_post = Some(post.to_string());
    }

    // like: П54 or ЦФП157
    '_if: {
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r#"\s(?P<post>[а-яіїА-ЯІЇ]{0,2}(П|п)-{0,1}\d+)"#)
                    .unwrap();
        }
        let Some(capts) = RE.captures(&scan_inp) else {
            break '_if;
        };
        let Some(post) = m_cap_s(&capts, "post") else {
            break '_if;
        };
        return Ok(Some(post.to_string()));
    }

    // like: "ЦФП14"
    '_if: {
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r#"\s"(?P<post>[а-яіїА-ЯІЇ]{0,2}(П|п)\d+)""#)
                    .unwrap();
        }
        let Some(capts) = RE.captures(&scan_inp) else {
            break '_if;
        };
        let Some(post) = m_cap_s(&capts, "post") else {
            break '_if;
        };
        return Ok(Some(post.to_string()));
    }

    // like: (ЦФП90)
    '_if: {
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r#"\s\((?P<post>[а-яіїА-ЯІЇ]{0,2}(П|п)\d+)\)"#)
                    .unwrap();
        }
        let Some(capts) = RE.captures(&scan_inp) else {
            break '_if;
        };
        let Some(post) = m_cap_s(&capts, "post") else {
            break '_if;
        };
        return Ok(Some(post.to_string()));
    }

    // like: ЦФП 80
    '_if: {
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r#"\s(?P<post>ЦФП \d+)"#).unwrap();
        }
        let Some(capts) = RE.captures(&scan_inp) else {
            break '_if;
        };
        let Some(post) = m_cap_s(&capts, "post") else {
            break '_if;
        };
        return Ok(Some(post.to_string()));
    }

    // like: П34 just one in the string
    '_if: {
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r#"^(?P<post>[а-яіїА-ЯІЇ]{0,2}(П|п)\d+)$"#).unwrap();
        }
        let Some(capts) = RE.captures(inp) else {
            break '_if;
        };
        let Some(post) = m_cap_s(&capts, "post") else {
            break '_if;
        };
        return Ok(Some(post.to_string()));
    }

    Ok(transit_post)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_post_mouse_01() {
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
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "П54".to_string())
    }

    #[test]
    fn extract_post_mouse_02() {
        let body = r#"
            ⚠️ 26.06, 22:31:50 ЦФП51
УКХ р/м управління 2 мсб 114 мсп 127 мсд 5 А (зх. ЧКАЛОВА)
НВ
МИТЯ, ГНОМ, КУБА, ИМАН
47.46133, 35.51282

1. Митя, Гном, Куба, Иман. Коса 18. Слышали, да?????"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "ЦФП51".to_string())
    }

    #[test]
    fn extract_post_mouse_03() {
        let body = r#"
30.03.2023_20:50 F=420,4250(МГц)
управління мсб 60 омсбр 5 ЗА (МАКАРІВКА, НЕСКУЧНЕ)
МУЗЫКАНТ
НВ (НВ)
"- На 22-й скажите, что крестики-нолики - работают
- (НВ) Я на 420-й разговариваю, так что не переживай"
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res, None)
    }

    #[test]
    fn extract_post_extra_01() {
        let body = r#"Отримано з поста "DOT3_1 (77)"
--------------------------------------
05.05, 10:35:48
433.0250
УКХ р/м НВ підрозділу 433.025 МГц (н.п. Покровське)
НВ
НВ

— Лондон, Мавик.

Мітки перехоплення: 🦅 - Спостерігають БПЛА СОУ
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "DOT3_1 (77)".to_string())
    }

    #[ignore]
    #[test]
    fn extract_post_extra_02() {
        let body = r#"П34
28.11, 18:30:58
415.1250
УКХ р/м НВ підрозділу 415.125 МГц
НВ
НВ

— .... поле 202."#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "П34".to_string())
    }

    #[test]
    fn extract_post_buran() {
        let body = r#"
30.03.2023_Дата: 2024-03-02;
Час: 07:09;
Частота: 460.3250;
Пост: П325;
Локація: Авдіївка - Ласточкіне;
Підрозділ: УКХ р/м 1 мсб 5 омсбр;
Хто: КАЛУГА;
Кому: БРЕСТ;
Текст:
- Калуга
- Брест
- Это кассеты по нам работают, не надо назад, вперед не останавливайтесь.Какие нахуй соседи по вам ложат, мы стреляем по лесополосе,вперед пошли пока ничего не летеит, быстрее. У нас БКне безгранично, идем пока держым.Вы чо сука охуели, почему вперед не идёте, Быстрее пошли пока нету воздействия, пока идем по всем фронтам, что один раз прилитело и вы обосрались, сейчас вон по 455 ебашут нахуй потому что там пацаны тоже идут. Пошли быстрее
- СТарший я Брест я не понял в чем дело, мы только ебашим, прикрываем. Идем ребятки. Не по вам давайте быстрее и закрепляйтесь. Заходите закрепляйтесь молодци ребята, Ребята вы где уже в нашей полосе? Всё вы уже в блиндаже?сейчас подойду;"
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "П325".to_string())
    }

    #[test]
    fn extract_post_double_quoted() {
        let body = r#"
Отримано з поста "П153"
--------------------------------------
11.11, 07:39:51
450.4650
(р-н Приютне) (йм. 394 мсп 127 мсд 5 А)
НВ
АСС

— Близко не подлетай, не забывай, там РЭБ, сбоку уйди, сбок, сбок, чтобы сейчас сопровождали через Малину, первую колонну, первые 3 единицы. Они должны через Малину уехать, через Малину первые 3 техники налево.
— На Малину, на Малину смотри, чтобы не проебали, чтобы на Малину не повернули, это высши, блядь, этот, ебаный. Ну ты понял?
— Асс, смотри, эту колонну ведешь, пока.
— Асс ну ка на другие колонны, повиси где нибудь в поле.
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "П153".to_string())
    }

    #[test]
    fn extract_post_parentheses() {
        let body = r#"
11.11, 13:58
УКХ р/м н/в підрозділу зі складу 114 мсп 127 мсд 5А (ймовірно ГСАДн) (ЦФП90)
НВ

- У Малины коробочку подать до Донецка
- Принял
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "ЦФП90".to_string())
    }

    #[test]
    fn extract_post_double_quoted_and_parentheses() {
        let body = r#"
11.11, 13:58
УКХ р/м н/в підрозділу зі складу 114 мсп 127 мсд 5А (ймовірно ГСАДн) "ЦФП90)
НВ

- У Малины коробочку подать до Донецка
- Принял
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res, None)
    }

    #[test]
    fn extract_post_first_string_post() {
        let body = r#"
П34
11.11, 15:29:04
404.5250
УКХ р/м йм. 2 мсб 503 мсп 19 мсд 58 А (МИРНЕ)
НВ
НВ

— Тополь, Тополь, я Черный, на месте 303.
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "П34".to_string())
    }

    #[test]
    fn extract_post_otrymano_only_1() {
        let body = r#"
Zenit
Отримано з поста "Solist_52"
--------------------------------------
11.11, 15:22:36
413.5008
УКХ р/м НВ підрозділу 1197 мсп 49 ЗвА 413.500 МГц
НВ
НВ

— Дрон 5, Воздух.
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "Solist_52".to_string())
    }

    #[test]
    fn extract_post_otrymano_and_cfp() {
        let body = r#"
Отримано з поста "rer108"
--------------------------------------
11.11, 15:23:28
408.4500
УКХ р/м йм 1198 мсп (Загірне) 408.450 МГц ЦФП 80
КОРШУН
ГРЕК, УЛЯ

— грек,грек, я Коршун, прием.
— На грека, на грека. Уля, Уля, я Коршун, прием.
— Гвозди мне принесите.
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "ЦФП 80".to_string())
    }

    #[test]
    fn extract_post_otrymano_only_2() {
        let body = r#"
Kupol80
Отримано з поста "Сфінкс"
--------------------------------------
28.11, 18:44:32
407.7375
УКХ р/м 1196 МСП 49 ЗА F=407.7350
ДИНАМО
НВ

— Победа, Победа, Динамо, прием.
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "Сфінкс".to_string())
    }

    #[test]
    fn extract_post_otrymano_only_3() {
        let body = r#"
Отримано з поста "Argo I. ЦФП_162"
--------------------------------------
28.11, 18:29:05
452.5008
УКХ р/м НВ підрозділу 452.5008 МГц
НВ
НВ

— чингисхан, чингисхан, я мак 22, прием.
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "Argo I. ЦФП_162".to_string())
    }

    #[test]
    fn extract_post_otrymano_only_4() {
        let body = r#"
Отримано з поста "2/101"                                                                                  
 --------------------------------------                                                                    
 16.07, 16:53:45                                                                                           
 142.8800                                                                                                  
 УКХ р/м командира 116 осп 110 омсбр (смуга відп. НОВАЯ ПОГАЩЬ-ТРОЄБОРТНЕ, Брянська об.)                   
 КОМЕТА                                                                                                    
 ТОПОЛЬ                                                                                                    
                                                                                                           
 — Тополь, Тополь, я Комета, прием.                                                                        
 — Тополь, Тополь, я Комета, прием.                                                                        
 — Комета, Комета, Тополь, прием.                                                                          
 — Тополь, Тополь, Комета на приеме.                                                                       
 — Плутон тебе отвечал, ты его принимаешь?                                                                 
 — Минус, минус.                                                                                           
 — Унего что то с основным запасным, он сейчас на безлимите у березки.                                     
 — Марс Тополь на приеме.                                                                                  
 — ..Тополь, я Макс, твоя информация для Кометы, ..краб прибывает по серому, по серому. Как принял?        
 — ты от Кометы информацию принимал .. ?                                                                   
 — Тополь, Тополь, я Комета, передай на Плутон, Яру, тоже, с вещами и копьем, на старый Нептун. Как принял?
 — да, принял тебя ..                                                                                      
                                                                                                           
 Мітки перехоплення: 🏃 - переміщення о/с, зміна о/с на позиції
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "2/101".to_string())
    }

    #[test]
    fn extract_post_otrymano_cpf_dash() {
        let body = r#"
28.11, 18:30:54
438.7502 ЦФП-51
УКХ р/м НВ підрозділу 438.7502 МГц
ТИТАН
ЗЕМА

— Зема, Зема Титану.
- ..................?
— По рельсам, по акуле, по западу ничего не наблюдаешь?
— Акула, западная, Вербовая южная, Вербовая северная, центральная.
— Та вроде бы техника по акуле.
— Плюс, спасибо.
"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "ЦФП-51".to_string())
    }

    #[test]
    fn extract_post_otrymano_unquoted_numeric_underscore() {
        let body = r#"4333_1
Отримано з поста 4333_1
--------------------------------------
15.08.2025, 16:44:40
161.2000
УКХ р/м НВ підрозділу 161.200 МГц
ПЕСОК
НВ

— Песок, расход 10, 10-ка ушла на восток, по северу."#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "4333_1".to_string())
    }

    #[test]
    fn extract_post_with_label_prefix() {
        let body = r#"32 15.08.2025
16:13:18
419.46DMR (HYTERA (256 bit))
Пост: П123
ЗЕМЛЯ
16:10:28
15-й
30-й
Также высокоскоростные? в секторе работаю"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "П123".to_string())
    }

    #[test]
    fn extract_post_p16_should_not_parse() {
        let body = r#"17.08.2025, 07:29:16
333.2260
🌻УКХ р/м підрозділу зі складу 128 омсбр 44 АК (Вовчанськ)🌻
НВ
НВ

— Хищник , Психу.
— Хищник на связи.
-- Хищник, Хищник эти провода, полевка разъебанная. Надо полевка, брат, полевка, полевку скинуть.
— Плюс, плюс, плюс, плюс. Сейчас, сейчас, сейчас, что ни придумаем, сейчас что ни придумаем.
-- ..полевку скинуть.?
-- Барс, Барс. На П16, на П16. Как принял?
-- На П16 сколько полевки тебе кинуть?
-- 200, 200 метров, 200 метров. Как принял?
- Я Барс, да.
— Спасибо, спасибо, Барс.
-- Барс Хищнику, Барс Хищнику.
-- Хищник, я Барс, на приеме.
-- Барс, а можно это сделать в ближайшее время, самое ближайшее время? Как принял меня?
--..
— Не прошло, не прошло, Барс.
-- Кроме полевки, что тебе еще нужно?
-- В принципе все, все остальное есть, все остальное есть там. Изоленты если только.
-- А МОНок хватает?
-- Да, да, да, да, вполне, вполне хватит, вполне хватит. И можно изоленты разных цветов, чтобы пометить, какая, откуда, куда.
— Ну по разным цветам не знаю, изоленту кинут.
- плюс, плюс, спасибо. Барс, Барс, Туар, Барс, Барс."#;
        let res = extract_post(body).unwrap();
        assert_eq!(res, None)
    }

    #[test]
    fn extract_post_cfp_with_dash_and_cyrillic_suffix() {
        let body = r#"27.10.2025_20:35 F=154.2500(МГц)
Отримано з поста "ЦФП10-М6"
р/м управління мінбатр 3 мсб 255 мсп 20 мсд 8 А (РАЙОН НОВООЛЕНІВКА, ТАРАСІВКА)
БИЗОН
МАЛЫШ
НВ
- (1) МАЛЫШ я БИЗОН на приеме
- (2) БИЗОН я МАЛЫШ, что там по нашей ситуации, какие наши действия?
- Ожидайте, едут к вам на помощь"#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "ЦФП10-М6".to_string())
    }


    #[test]
    fn extract_post_with_asterisk() {
        let body = r#"Отримано з поста "**33"
--------------------------------------
18.11.2025, 07:39:45
124.325

⚫ УКХ р/м управління повітряним рухом в зоні відповідальності ае “Центральний” (Ростов-на-Дону) ПКС зс рф

46579
ФИНАЛ
-Финал 46579
-Привет
-46579, доброе утро экипажам ...одиночных площадок, следую к вам, прошел ... Александровка вошел вашу зону, подход ..."#;
        let res = extract_post(body).unwrap();
        assert_eq!(res.unwrap(), "**33".to_string())
    }    
}
