use crate::error::AppError;
use crate::rer_importer::signals::CNSignal;
use crate::utils::string::*;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use serde::{Deserialize, Serialize};
use substring::Substring;
use unicode_segmentation::UnicodeSegmentation;

use super::body_noheader::NoHeadersBody;

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub enum ContentNode {
    CNTextC(CNText),
    CNNewlineC,
    CNCallsignC(CNCallsign),
    CNHighlightC(CNHighlight),
    CNSignalC(CNSignal),
    CNPointC(CNPoint),
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CNText {
    text: String,
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
    PartialOrd,
    Ord,
    Eq,
)]
pub struct CNCallsign {
    pub begin: usize,
    pub end: usize,
    /// etalon, lowercase
    pub etalon: String,
    /// exact part of message being highlighed, == msg\[begin:end\]
    pub text: String,
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
    PartialOrd,
    Ord,
    Eq,
)]
pub struct CNPoint {
    pub begin: usize,
    pub end: usize,
    pub etalon: String,
    pub text: String,
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct CNHighlight {
    pub text: String,
    pub begin: usize,
    pub end: usize,
}

pub fn extract_ts_headline_keywords(
    input: &str,
    no_header_body_start: Option<usize>,
    ts_headline: &str,
) -> Result<Vec<CNHighlight>, AppError> {
    let mut res = vec![];
    let mut first = true;
    let mut cursor = 0;
    for part in ts_headline.split("<b>") {
        if first {
            // res.push(CNHighlight {
            //     text: part.to_string(),
            //     begin: cursor,
            //     end: cursor + cline_len(part),
            // });
            cursor += cline_len(part);
            first = false;
            continue;
        }
        let mut parts2 = part.split("</b>");
        if let Some(part2_bold) = parts2.next() {
            if cursor >= no_header_body_start.unwrap_or(0) {
                res.push(CNHighlight {
                    // text: part2_bold.to_string(),
                    text: input
                        .to_string()
                        .substring(cursor, cursor + cline_len(part2_bold))
                        .to_string(),
                    begin: cursor,
                    end: cursor + cline_len(part2_bold),
                });
            }
            // cursor += cline_len(part2_bold) + 4;
            cursor += cline_len(part2_bold);
            if let Some(part2_norm) = parts2.next() {
                if !part2_norm.is_empty() {
                    // res.push(CNHighlight {
                    //     text: part2_norm.to_string(),
                    //     begin: cursor,
                    //     end: cursor + cline_len(part2_norm),
                    // });
                    cursor += cline_len(part2_norm);
                }
            }
        }
        // cursor += 3;
    }

    // println!("> extract_ts_headline_keywords: {res:#?}");

    Ok(res)
}

#[derive(Debug, Clone, Copy)]
pub struct HighlightOpts {
    pub highlight_callsigns: Option<bool>,
    pub highlight_keywords: Option<bool>,
    pub highlight_signals: Option<bool>,
    pub highlight_searchres: Option<bool>,
    pub highlight_points: Option<bool>,
}

impl HighlightOpts {
    pub fn all() -> HighlightOpts {
        HighlightOpts {
            highlight_callsigns: Some(true),
            highlight_signals: Some(true),
            highlight_keywords: Some(true),
            highlight_searchres: Some(true),
            highlight_points: Some(true),
        }
    }
}

/// ts_headline: result of ts_headline call in PostgreSQL with default
/// <b> param and HighlightAll=true </b>
pub fn highlight(
    input: &str,
    input_no_header: Option<&NoHeadersBody>,
    callsigns: &Vec<CNCallsign>,
    points: &Vec<CNPoint>,
    keywords: &Vec<CNHighlight>,
    signals: &Vec<CNSignal>,
    ts_headline: Option<String>,
    highlight_opts: HighlightOpts,
) -> Result<Vec<ContentNode>, AppError> {
    // println!("> input: {input}");
    // println!("> ts_headline: {}", ts_headline.clone().unwrap_or("".to_string()));

    #[derive(Debug, Clone)]
    pub enum Special {
        Signal(CNSignal),
        Callsign(CNCallsign),
        Keyword(CNHighlight),
        Point(CNPoint),
    }
    impl Special {
        pub fn begin(&self) -> usize {
            match self {
                Special::Signal(x) => x.begin,
                Special::Callsign(x) => x.begin,
                Special::Keyword(x) => x.begin,
                Special::Point(x) => x.begin,
            }
        }
        pub fn end(&self) -> usize {
            match self {
                Special::Signal(x) => x.end,
                Special::Callsign(x) => x.end,
                Special::Keyword(x) => x.end,
                Special::Point(x) => x.end,
            }
        }
        pub fn text(&self) -> String {
            match self {
                Special::Signal(x) => x.text.clone(),
                Special::Callsign(x) => x.text.clone(),
                Special::Keyword(x) => x.text.clone(),
                Special::Point(x) => x.text.clone(),
            }
        }
    }

    let mut res = vec![];
    let mut specials: Vec<Special> = vec![];
    let no_header_body_start = input_no_header.map(|x| x.start).unwrap_or(0);

    if highlight_opts.highlight_callsigns == Some(true) {
        specials.extend(callsigns.iter().map(|x| Special::Callsign(x.clone())));
    }
    if highlight_opts.highlight_points == Some(true) {
        specials.extend(points.iter().map(|x| Special::Point(x.clone())));
    }
    if highlight_opts.highlight_keywords == Some(true) {
        specials.extend(keywords.iter().map(|x| Special::Keyword(x.clone())));
    }
    if highlight_opts.highlight_signals == Some(true) {
        specials.extend(
            signals
                .iter()
                .map(|x| Special::Signal(x.clone()))
                .filter(|x| x.begin() >= no_header_body_start),
        );
    }
    // println!(
    //     "> highlight_searchres: {:?}",
    //     highlight_opts.highlight_searchres
    // );
    if highlight_opts.highlight_searchres == Some(true) {
        // println!("> ts_headline: {:?}", ts_headline);
        if let Some(headline) = ts_headline {
            let keywords2 = extract_ts_headline_keywords(
                input,
                Some(no_header_body_start),
                &headline,
            )?;
            specials
                .extend(keywords2.iter().map(|x| Special::Keyword(x.clone())));
        }
    }
    specials.sort_by_key(|a| a.begin());
    // println!("> specials: {specials:#?}");

    let mut msg_pos = 0;
    for line in input.lines() {
        // println!(">>>>>>>>>>>>>");
        // println!("> line: {line}");
        // println!("> msg_pos: {msg_pos}");
        let line_specials0: Vec<Special> = specials
            .iter()
            .filter(|x| {
                x.begin() >= msg_pos && x.end() <= msg_pos + cline_len(line)
            })
            .cloned()
            .collect();
        // filter out non-intersecting begin/ends
        let mut line_specials = vec![];
        let mut curending = 0;
        for x in line_specials0 {
            if x.begin() >= curending {
                curending = x.end();
                line_specials.push(x);
            }
        }
        // println!("> line_specials: {line_specials:?}");
        let mut line_nodes = vec![];
        let mut line_pos = 0;
        for special in line_specials {
            if special.begin() > msg_pos + line_pos {
                let take_before_callsign = special.begin() - msg_pos - line_pos;
                // println!("> take_before_callsign: {take_before_callsign}");
                line_nodes.push(ContentNode::CNTextC(CNText {
                    text: line
                        .substring(line_pos, line_pos + take_before_callsign)
                        .to_string(),
                }));
                line_pos += take_before_callsign;
            }
            line_nodes.push(match special {
                Special::Callsign(ref x) => ContentNode::CNCallsignC(x.clone()),
                Special::Signal(ref x) => ContentNode::CNSignalC(x.clone()),
                Special::Keyword(ref x) => ContentNode::CNHighlightC(x.clone()),
                Special::Point(ref x) => ContentNode::CNPointC(x.clone()),
            });
            line_pos += cline_len(&special.text());
            // line_pos = callsign.end - msg_pos;
        }
        // println!("> line.clen: {0}, line_pos: {line_pos}", cline_len(line));
        if cline_len(line) > 0 && line_pos <= cline_len(line) {
            let take_rest = cline_len(line) - line_pos;
            if take_rest > 0 {
                let rest =
                    line.substring(line_pos, cline_len(line)).to_string();
                // println!("> rest of line: {rest}");
                line_nodes.push(ContentNode::CNTextC(CNText { text: rest }))
            }
        }

        line_nodes.push(ContentNode::CNNewlineC);

        res.append(&mut line_nodes);

        msg_pos += cline_len(line) + 1;
    }
    if !res.is_empty() {
        res.remove(res.len() - 1);
    }
    // println!("> res: {res:?}");
    Ok(res)
}

pub fn extract_keywords(inp: &str) -> Result<Vec<CNHighlight>, AppError> {
    let keywords = super::keywords::get_keywords();
    let bounds: Vec<String> = inp
        .to_string()
        .split_word_bounds()
        .map(|x| x.to_string())
        .collect::<Vec<String>>();
    let mut res = vec![];
    let mut pos = 0;
    for bound in bounds {
        let bound_l = bound.to_lowercase();
        if keywords.contains(&bound_l) {
            res.push(CNHighlight {
                text: bound.clone(),
                begin: pos,
                end: pos + cline_len(&bound),
            });
        }
        pos += cline_len(&bound);
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_highlight_01() {
        let body = r#"14.04.2023_09:27 F=420,3500(МГц) п3
УКХ р/м мсб зі складу 177 , МАРФОПІЛЬ - РЕШЕТИЛІВСЬКЕ (НВ)
НВ (НВ)
НВ (НВ)
"1. Над СПЛАВОМ птичка летает, похоже что то скидывает, её пытаются с пулемёта расстрелять, но она жужжит.""#;
        let res = highlight(
            body,
            None,
            &vec![],
            &vec![],
            &vec![],
            &vec![],
            None,
            HighlightOpts::all(),
        )
        .unwrap();
        assert_eq!(
            res[0],
            ContentNode::CNTextC(CNText {
                text: "14.04.2023_09:27 F=420,3500(МГц) п3".to_string()
            })
        );
        assert_eq!(res[1], ContentNode::CNNewlineC);
    }

    #[test]
    fn test_highlight_02() {
        let body = r#"14.04.2023_09:27 F=420,3500(МГц) п3
УКХ р/м мсб зі складу 177 , МАРФОПІЛЬ - РЕШЕТИЛІВСЬКЕ (НВ)
ЛОХ (НВ)
НВ (НВ)
"1. Над СПЛАВОМ птичка летает, похоже что то скидывает, её пытаются с пулемёта расстрелять, но она жужжит.""#;
        let callsigns = vec![CNCallsign {
            begin: 95,
            end: 95 + 3,
            etalon: "лох".to_string(),
            text: "ЛОХ".to_string(),
        }];
        let res = highlight(
            body,
            None,
            &callsigns,
            &vec![],
            &vec![],
            &vec![],
            None,
            HighlightOpts::all(),
        )
        .unwrap();
        assert_eq!(
            res[0],
            ContentNode::CNTextC(CNText {
                text: "14.04.2023_09:27 F=420,3500(МГц) п3".to_string()
            })
        );
        assert_eq!(res[1], ContentNode::CNNewlineC);
        println!("{res:#?}");
        assert_eq!(
            res[4],
            ContentNode::CNCallsignC(CNCallsign {
                begin: 95,
                end: 98,
                etalon: "лох".to_string(),
                text: "ЛОХ".to_string()
            })
        );
        assert_eq!(
            res[5],
            ContentNode::CNTextC(CNText {
                text: " (НВ)".to_string()
            })
        );
        assert_eq!(res[6], ContentNode::CNNewlineC);
        assert_eq!(
            res[7],
            ContentNode::CNTextC(CNText {
                text: "НВ (НВ)".to_string()
            })
        );
    }

    #[test]
    fn test_highlight_03() {
        let body = r#"17.04.2023_14:33 F=408,3000(МГц)
Не встановлено (НВ)
МАЛЫШ (НВ)
ГАМАН (НВ)
"1. ну скажы Чибису чтобы веник взял и что он обещал танисту тоже пускай берёт
2. я понял тебя.""#;
        let callsigns = vec![
            CNCallsign {
                begin: 53,
                end: 53 + 5,
                etalon: "малыш".to_string(),
                text: "МАЛЫШ".to_string(),
            },
            CNCallsign {
                begin: 64,
                end: 64 + 5,
                etalon: "гаман".to_string(),
                text: "ГАМАН".to_string(),
            },
            CNCallsign {
                begin: 88,
                end: 88 + 6,
                etalon: "чибис".to_string(),
                text: "Чибису".to_string(),
            },
        ];
        let res = highlight(
            body,
            None,
            &callsigns,
            &vec![],
            &vec![],
            &vec![],
            None,
            HighlightOpts::all(),
        )
        .unwrap();
        println!("{:?}", res[4]);
        println!("{:?}", res[5]);

        assert_eq!(
            res[4],
            ContentNode::CNCallsignC(CNCallsign {
                begin: 53,
                end: 58,
                etalon: "малыш".to_string(),
                text: "МАЛЫШ".to_string()
            })
        );
        assert_eq!(
            res[5],
            ContentNode::CNTextC(CNText {
                text: " (НВ)".to_string()
            })
        );
    }

    #[test]
    fn test_highlight_04() {
        let body = r#"18.04.2023_08:26 F=415,1000(МГц)
УКХ р/м 1 мсб 70 мсп 42 мсд 58 А (ПАВЛІВСЬКЕ, НОВОФЕДОРІВКА)
КОМАТИ
СЕДОЙ
"-  ...Седой на связи
 -  Там вам передавали давненько правда теплак, коробка где-то у вас лежит название его скажи пожалуйста
 - (1) Комати Седому
 -  Да на прийоме
 -  Модель, просто модель
 -  Принял
 -  ... название, как ты назвал , Саим!?
 -  Принял"#;
        let callsigns = vec![
            CNCallsign {
                begin: 94,
                end: 100,
                etalon: "комати".to_string(),
                text: "КОМАТИ".to_string(),
            },
            CNCallsign {
                begin: 101,
                end: 106,
                etalon: "седой".to_string(),
                text: "СЕДОЙ".to_string(),
            },
        ];
        let res = highlight(
            body,
            None,
            &callsigns,
            &vec![],
            &vec![],
            &vec![],
            None,
            HighlightOpts::all(),
        )
        .unwrap();
        println!("{:?}", res[4]);
        println!("{:?}", res[6]);
        assert_eq!(
            res[4],
            ContentNode::CNCallsignC(CNCallsign {
                begin: 94,
                end: 100,
                etalon: "комати".to_string(),
                text: "КОМАТИ".to_string()
            })
        );
        assert_eq!(
            res[6],
            ContentNode::CNCallsignC(CNCallsign {
                begin: 101,
                end: 106,
                etalon: "седой".to_string(),
                text: "СЕДОЙ".to_string()
            })
        );
    }

    #[test]
    fn test_highlight_05() {
        let body = r#"10:02	F= 430.5250	УКХ р/м 2 мсб 114 мсп	


- небо чистое противника не слышна"#;
        let callsigns = vec![CNCallsign {
            begin: 45,
            end: 49,
            etalon: "небо".to_string(),
            text: "небо".to_string(),
        }];
        let keywords = vec![CNHighlight {
            begin: 45,
            end: 49,
            text: "небо".to_string(),
        }];
        let res = highlight(
            body,
            None,
            &callsigns,
            &vec![],
            &keywords,
            &vec![],
            None,
            HighlightOpts::all(),
        )
        .unwrap();
        println!("{res:?}");
        assert_eq!(
            res,
            [
                ContentNode::CNTextC(CNText {
                    text: "10:02\tF= 430.5250\tУКХ р/м 2 мсб 114 мсп\t"
                        .to_string()
                }),
                ContentNode::CNNewlineC,
                ContentNode::CNNewlineC,
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText {
                    text: "- ".to_string()
                }),
                ContentNode::CNCallsignC(CNCallsign {
                    begin: 45,
                    end: 49,
                    etalon: "небо".to_string(),
                    text: "небо".to_string()
                }),
                ContentNode::CNTextC(CNText {
                    text: " чистое противника не слышна".to_string()
                })
            ]
        );
        // assert_eq!(
        //     res[6],
        //     ContentNode::CNCallsignC(CNCallsign {
        //         begin: 101,
        //         end: 106,
        //         etalon: "седой".to_string(),
        //         text: "СЕДОЙ".to_string()
        //     })
        // );
    }

    #[test]
    fn test_highlight_06() {
        let body = r#"21.04.2023_10:03 F=408,3000(МГц)
ймов. 3 мсб 38 омсбр (ЗАГІРНЕ)/70 мсп 42 мсд
КУДАСОВ
ЕНИСЕЙ 
"-  Туд а до 22го не могу выйти, вобщем ему надо довести информацию, что идет работа по (потю)....было 2й роты, как принял меня
 -  ...Кудасов
 - (1) Енисей Кудасов"#;
        let callsigns = vec![
            CNCallsign {
                end: 85,
                text: "КУДАСОВ".to_string(),
                begin: 78,
                etalon: "кудасов".to_string(),
            },
            CNCallsign {
                end: 92,
                text: "ЕНИСЕЙ".to_string(),
                begin: 86,
                etalon: "енисей".to_string(),
            },
            CNCallsign {
                end: 199,
                text: "2й".to_string(),
                begin: 197,
                etalon: "2й".to_string(),
            },
            CNCallsign {
                end: 236,
                text: "Кудасов".to_string(),
                begin: 229,
                etalon: "кудасов".to_string(),
            },
            CNCallsign {
                end: 250,
                text: "Енисей".to_string(),
                begin: 244,
                etalon: "енисей".to_string(),
            },
            CNCallsign {
                end: 258,
                text: "Кудасов".to_string(),
                begin: 251,
                etalon: "кудасов".to_string(),
            },
        ];
        let keywords = vec![];
        let res = highlight(
            body,
            None,
            &callsigns,
            &vec![],
            &keywords,
            &vec![],
            None,
            HighlightOpts::all(),
        )
        .unwrap();
        println!("{res:?}");
        assert_eq!(
            res,
            [
                ContentNode::CNTextC(CNText { text: "21.04.2023_10:03 F=408,3000(МГц)".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: "ймов. 3 мсб 38 омсбр (ЗАГІРНЕ)/70 мсп 42 мсд".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNCallsignC(CNCallsign { begin: 78, end: 85, etalon: "кудасов".to_string(), text: "КУДАСОВ".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNCallsignC(CNCallsign { begin: 86, end: 92, etalon: "енисей".to_string(), text: "ЕНИСЕЙ".to_string() }),
                ContentNode::CNTextC(CNText { text: " ".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: "\"-  Туд а до 22го не могу выйти, вобщем ему надо довести информацию, что идет работа по (потю)....было ".to_string() }),
                ContentNode::CNCallsignC(CNCallsign { begin: 197, end: 199, etalon: "2й".to_string(), text: "2й".to_string() }),
                ContentNode::CNTextC(CNText { text: " роты, как принял меня".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: " -  ...".to_string() }),
                ContentNode::CNCallsignC(CNCallsign { begin: 229, end: 236, etalon: "кудасов".to_string(), text: "Кудасов".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: " - (1) ".to_string() }),
                ContentNode::CNCallsignC(CNCallsign { begin: 244, end: 250, etalon: "енисей".to_string(), text: "Енисей".to_string() }),
                ContentNode::CNTextC(CNText { text: " ".to_string() }),
                ContentNode::CNCallsignC(CNCallsign { begin: 251, end: 258, etalon: "кудасов".to_string(), text: "Кудасов".to_string() })]
        )
        // assert_eq!(
        //     res,
        //     [
        //         ContentNode::CNTextC(CNText {
        //             text: "10:02\tF= 430.5250\tУКХ р/м 2 мсб 114 мсп\t"
        //                 .to_string()
        //         }),
        //         ContentNode::CNNewlineC,
        //         ContentNode::CNNewlineC,
        //         ContentNode::CNNewlineC,
        //         ContentNode::CNTextC(CNText {
        //             text: "- ".to_string()
        //         }),
        //         ContentNode::CNCallsignC(CNCallsign {
        //             begin: 45,
        //             end: 49,
        //             etalon: "небо".to_string(),
        //             text: "небо".to_string()
        //         }),
        //         ContentNode::CNTextC(CNText {
        //             text: " чистое противника не слышна".to_string()
        //         })
        //     ]
        // );
    }

    #[test]
    fn test_highlight_07() {
        let body = r#"Туда до 22го не могу выйти, вобщем ему надо довести информацию, что идет работа по (потю)....было 2й роты, как принял меня"#;
        let callsigns = vec![];
        let keywords = vec![];
        let search = Some(
            r#"Туда до 22го не могу выйти, вобщем ему надо довести <b>информацию</b>, что идет работа по (потю)....было 2й роты, как принял меня"#.to_string(),
        );
        let res = highlight(
            body,
            None,
            &callsigns,
            &vec![],
            &keywords,
            &vec![],
            search,
            HighlightOpts::all(),
        )
        .unwrap();
        println!("{res:?}");
        assert_eq!(
            res,
            [
                ContentNode::CNTextC(CNText { text: "Туда до 22го не могу выйти, вобщем ему надо довести ".to_string() }),
                ContentNode::CNHighlightC(CNHighlight { text: "информацию".to_string(), begin: 52, end: 52+10 }),
                ContentNode::CNTextC(CNText { text: ", что идет работа по (потю)....было 2й роты, как принял меня".to_string() }),
            ]
        )
    }

    #[test]
    fn test_highlight_08() {
        let body = r#"29.06.2023_09:59 F=405,5300(МГц) П52
2-й мсб 70 мсп (район ІНЖЕНЕРНЕ, ІВАНА ФРАНКА, КОСТЯНТИНІВКА)
КАСПИЙ
КАГАН
"- (1) Как обстановка?
 -  00 5
 -  Через пару часов я за ним прийду
 -  Ты вызывал Кагана или Гамана?
 -  Кагана"#;
        let callsigns = vec![];
        let keywords = vec![];
        let search = Some(
            r#"29.06.2023_09:59 f=405,5300(мгц) п52
2-й мсб 70 мсп (район інженерне, івана франка, костянтинівка)
каспий
<b>каган</b>
"- (1) как обстановка?
 -  00 5
 -  через пару часов я за ним прийду
 -  ты вызывал <b>кагана</b> или гамана?
 -  <b>кагана</b>"#
                .to_string(),
        );
        let res = highlight(
            body,
            None,
            &callsigns,
            &vec![],
            &keywords,
            &vec![],
            search,
            HighlightOpts::all(),
        )
        .unwrap();
        let expected = [
                ContentNode::CNTextC(CNText { text: "29.06.2023_09:59 F=405,5300(МГц) П52".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: "2-й мсб 70 мсп (район ІНЖЕНЕРНЕ, ІВАНА ФРАНКА, КОСТЯНТИНІВКА)".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: "КАСПИЙ".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNHighlightC(CNHighlight { text: "КАГАН".to_string(), begin: 106, end: 111 }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: "\"- (1) Как обстановка?".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: " -  00 5".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: " -  Через пару часов я за ним прийду".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: " -  Ты вызывал ".to_string() }),
                ContentNode::CNHighlightC(CNHighlight { text: "Кагана".to_string(), begin: 196, end: 202 }),
                ContentNode::CNTextC(CNText { text: " или Гамана?".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: " -  ".to_string() }),
                ContentNode::CNHighlightC(CNHighlight { text: "Кагана".to_string(), begin: 219, end: 225 }),
            ];
        println!("> res:\n{res:#?}");
        println!("> expected:\n{expected:#?}");
        assert_eq!(res, expected)
    }

    #[test]
    fn test_highlight_09() {
        let expected = [
            ContentNode::CNTextC(
                CNText {
                    text: "29.06.2023_09:59 F=405,5300(МГц) П52".to_string(),
                },
            ),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(
                CNText {
                    text: "2-й мсб 70 мсп (район ІНЖЕНЕРНЕ, ІВАНА ФРАНКА, КОСТЯНТИНІВКА)".to_string(),
                },
            ),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(
                CNText {
                    text: "КАСПИЙ".to_string(),
                },
            ),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(
                CNText {
                    text: "КАГАН".to_string(),
                },
            ),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(
                CNText {
                    text: "\"- (1) Как обстановка?".to_string(),
                },
            ),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(
                CNText {
                    text: " -  00 5".to_string(),
                },
            ),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(
                CNText {
                    text: " -  Через пару часов ".to_string(),
                },
            ),
            ContentNode::CNSignalC(
                CNSignal {
                    begin: 165,
                    end: 175,
                    etalon: "буран 100".to_string(),
                    text: "буранa 100".to_string(),
                    id: 1,
                },
            ),
            ContentNode::CNTextC(
                CNText {
                    text: " за ним прийду".to_string(),
                },
            ),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(
                CNText {
                    text: " -  Ты вызывал Кагана или Гамана?".to_string(),
                },
            ),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(
                CNText {
                    text: " -  Кагана".to_string(),
                },
            ),
        ];
        let body = r#"29.06.2023_09:59 F=405,5300(МГц) П52
2-й мсб 70 мсп (район ІНЖЕНЕРНЕ, ІВАНА ФРАНКА, КОСТЯНТИНІВКА)
КАСПИЙ
КАГАН
"- (1) Как обстановка?
 -  00 5
 -  Через пару часов буранa 100 за ним прийду
 -  Ты вызывал Кагана или Гамана?
 -  Кагана"#;
        let res = highlight(
            body,
            None,
            &vec![],
            &vec![],
            &vec![],
            &vec![CNSignal {
                begin: 165,
                end: 175,
                text: "буранa 100".to_string(),
                etalon: "буран 100".to_string(),
                id: 1,
            }],
            None,
            HighlightOpts::all(),
        )
        .unwrap();
        println!("> res:\n{res:#?}");
        println!("> expected:\n{expected:#?}");
        assert_eq!(res, expected)
    }

    #[test]
    fn test_highlight_10() {
        let body = r#"29.06.2023_09:59 F=405,5300(МГц) П52
2-й мсб 70 мсп (район ІНЖЕНЕРНЕ, ІВАНА ФРАНКА, КОСТЯНТИНІВКА)
КАСПИЙ
ФРАНК
"- (1) Как обстановка?
 -  00 5
 -  Через пару часов я за ним прийду
 -  Ты вызывал Франка или Гамана?
 -  Франка"#;
        let body_noheader = NoHeadersBody {
            body: r#"КАСПИЙ
 ФРАНК
 "- (1) Как обстановка?
  -  00 5
  -  Через пару часов я за ним прийду
  -  Ты вызывал Франка или Гамана?
  -  Франка"#
                .to_string(),
            start: 99,
            end: 221,
        };
        let callsigns = vec![];
        let keywords = vec![];
        let search = Some(
            r#"29.06.2023_09:59 f=405,5300(мгц) п52
2-й мсб 70 мсп (район інженерне, івана <b>франка</b>, костянтинівка)
каспий
<b>франк</b>
"- (1) как обстановка?
 -  00 5
 -  через пару часов я за ним прийду
 -  ты вызывал <b>франка</b> или гамана?
 -  <b>франка</b>"#
                .to_string(),
        );
        let res = highlight(
            body,
            Some(&body_noheader),
            &callsigns,
            &vec![],
            &keywords,
            &vec![],
            search,
            HighlightOpts::all(),
        )
        .unwrap();
        let expected = [
                ContentNode::CNTextC(CNText { text: "29.06.2023_09:59 F=405,5300(МГц) П52".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: "2-й мсб 70 мсп (район ІНЖЕНЕРНЕ, ІВАНА ФРАНКА, КОСТЯНТИНІВКА)".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: "КАСПИЙ".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNHighlightC(CNHighlight { text: "ФРАНК".to_string(), begin: 106, end: 111 }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: "\"- (1) Как обстановка?".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: " -  00 5".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: " -  Через пару часов я за ним прийду".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: " -  Ты вызывал ".to_string() }),
                ContentNode::CNHighlightC(CNHighlight { text: "Франка".to_string(), begin: 196, end: 202 }),
                ContentNode::CNTextC(CNText { text: " или Гамана?".to_string() }),
                ContentNode::CNNewlineC,
                ContentNode::CNTextC(CNText { text: " -  ".to_string() }),
                ContentNode::CNHighlightC(CNHighlight { text: "Франка".to_string(), begin: 219, end: 225 }),
            ];
        println!("> res:\n{res:#?}");
        println!("> expected:\n{expected:#?}");
        assert_eq!(res, expected)
    }

    #[test]
    fn test_highlight_11() {
        let expected = [
            ContentNode::CNTextC(CNText {text: "Отримано з поста \"rer108\"".to_string()}),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(CNText {text: "--------------------------------------".to_string()}),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(CNText {text: "16.02, 22:44:57".to_string()}),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(CNText {text: "432.1500".to_string()}),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(
                CNText {
                    text: "УКХ р/м йм.  65 ОДШБ (НОВОПРОКОПІВКА- ВЕРБОВЕ) 432.150 МГц ЦФП 80".to_string(),
                },
            ),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(CNText {text: "ЛУНА".to_string()}),
            ContentNode::CNNewlineC,
            ContentNode::CNHighlightC(CNHighlight { text: "БОКС".to_string(), begin: 161, end: 165 }),
            ContentNode::CNNewlineC,
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(CNText {text: "— ".to_string()}),
            ContentNode::CNHighlightC(CNHighlight { text: "Бокс".to_string(), begin: 169, end: 173 }),
            ContentNode::CNTextC(CNText {text: ", ".to_string()}),
            ContentNode::CNHighlightC(CNHighlight { text: "Бокс".to_string(), begin: 175, end: 179 }),
            ContentNode::CNTextC(CNText {text: ", Луне.".to_string()}),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(CNText {text: "— Да, связь ".to_string()}),
            ContentNode::CNHighlightC(CNHighlight { text: "Бокс".to_string(), begin: 199, end: 203 }),
            ContentNode::CNTextC(CNText {text: ".".to_string()}),
            ContentNode::CNNewlineC,
            ContentNode::CNTextC(CNText {text: "— Плюс принял.".to_string()}),
        ];
        let body = r#"Отримано з поста "rer108"
--------------------------------------
16.02, 22:44:57
432.1500
УКХ р/м йм.  65 ОДШБ (НОВОПРОКОПІВКА- ВЕРБОВЕ) 432.150 МГц ЦФП 80
ЛУНА
БОКС

— Бокс, Бокс, Луне.
— Да, связь Бокс.
— Плюс принял."#;

        let body_noheader = NoHeadersBody {
            body: r#"ЛУНА
БОКС

— Бокс, Бокс, Луне.
— Да, связь Бокс.
— Плюс принял."#
                .to_string(),
            start: 156,
            end: 219,
        };

        let ts_headline = r#"Отримано з поста "rer108"
--------------------------------------
16.02, 22:44:57
432.1500
УКХ р/м йм.  65 ОДШБ (НОВОПРОКОПІВКА- ВЕРБОВЕ) 432.150 МГц ЦФП 80
ЛУНА
<b>БОКС</b>

— <b>Бокс</b>, <b>Бокс</b>, Луне.
— Да, связь <b>Бокс</b>.
— Плюс принял."#;

        let res = highlight(
            body,
            Some(&body_noheader),
            &vec![],
            &vec![],
            &vec![],
            &vec![],
            Some(ts_headline.to_string()),
            HighlightOpts::all(),
        )
        .unwrap();
        println!("> res:\n{res:#?}");
        println!("> expected:\n{expected:#?}");
        assert_eq!(res, expected)
    }

    #[test]
    fn test_extract_keywords_01() {
        let body = r#"26.03.2023_18:31 F=422,4300(МГц)
Не встановлено (НВ)
НВ (НВ)
НВ (НВ)
"-   Всё птичка в гнезде""#;
        let res = extract_keywords(body).unwrap();
        println!("{res:?}");
        assert_eq!(res.len(), 1);
        assert_eq!(
            res[0],
            CNHighlight {
                text: "птичка".to_string(),
                begin: 78,
                end: 84
            }
        );
    }

    #[test]
    fn test_extract_ts_headline_keywords_01() {
        let input = "Nуда куда сюда";
        let headline = "Туда <b>куда</b> сюда";
        let res = extract_ts_headline_keywords(input, None, headline).unwrap();
        assert_eq!(
            res,
            vec![CNHighlight {
                text: "куда".to_string(),
                begin: 5,
                end: 9,
            }]
        )
    }

    #[test]
    fn test_highlight_points_01() {
        let body = "Передай на точке Альфа";
        let points = vec![CNPoint {
            begin: 11,
            end: 16,
            etalon: "точка".to_string(),
            text: "точке".to_string(),
        }];
        let res = highlight(
            body,
            None,
            &vec![],
            &points,
            &vec![],
            &vec![],
            None,
            HighlightOpts {
                highlight_callsigns: Some(false),
                highlight_signals: Some(false),
                highlight_keywords: Some(false),
                highlight_searchres: Some(false),
                highlight_points: Some(true),
            },
        )
        .unwrap();
        assert_eq!(
            res,
            vec![
                ContentNode::CNTextC(CNText {
                    text: "Передай на ".to_string(),
                }),
                ContentNode::CNPointC(CNPoint {
                    begin: 11,
                    end: 16,
                    etalon: "точка".to_string(),
                    text: "точке".to_string(),
                }),
                ContentNode::CNTextC(CNText {
                    text: " Альфа".to_string(),
                }),
            ]
        );
    }
}

// TODO: add tests for points
