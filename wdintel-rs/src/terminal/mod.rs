use crate::error::AppError;
use crate::importer::RowInfo;
use crate::storage;
use crate::types::*;
use crate::users::ensure_basic_role;
use crate::utils::{multipart, trim_lines};
use actix_multipart::Multipart;
use actix_web::web::Json;
use actix_web::{post, put, HttpRequest};
use anyhow::Context;
use elm_rs::{Elm, ElmDecode, ElmEncode};
use lazy_static::lazy_static;
use nipper::Document;
#[cfg(feature = "opencv")]
use opencv::prelude::MatTraitConstManual;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
// use std::time::Duration;
use tempfile::TempDir;
use uuid::Uuid;

fn pdf_to_text(file: &Path) -> Result<String, AppError> {
    Ok(pdf_to_text_1(file).c(h!())?)
}

fn pdf_to_text_1(file: &Path) -> anyhow::Result<String> {
    println!("> file: {}", file.display());
    let tmp_dir = TempDir::new().c(h!())?;
    println!("> tmp_dir: {}", tmp_dir.path().display());
    let input_pdf = tmp_dir.path().join("input.pdf");
    println!("> input_pdf: {}", input_pdf.display());
    std::fs::copy(file, &input_pdf).c(h!())?;
    let output_txt = tmp_dir.path().join("output.txt");
    println!("> output_txt: {}", output_txt.display());
    let output = Command::new("pdftotext")
        .current_dir(tmp_dir.path())
        .arg(format!("{}", input_pdf.display()))
        .arg(format!("{}", output_txt.display()))
        .output()
        .c(h!())?;
    anyhow::ensure!(
        output.status.success(),
        "pdftotext exited with {}",
        output.status
    );
    let file_res = String::from_utf8_lossy(&std::fs::read(output_txt).c(h!())?)
        .to_string();
    Ok(file_res)
    // Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// | tmp_dir must be a tempdir with a file named "input.pdf". output file will be called "output.html"
fn pdf_to_html(tmp_dir: &Path) -> Result<String, AppError> {
    Ok(pdf_to_html_1(tmp_dir).c(h!())?)
}

fn pdf_to_html_1(tmp_dir: &Path) -> anyhow::Result<String> {
    println!("> pdf_to_html_1");
    let output_html = tmp_dir.join("output.html");
    println!("> tmp_dir: {}", tmp_dir.display());
    let output = Command::new("pdf2htmlEX")
        .current_dir(tmp_dir)
        .arg("--embed-image=0")
        .arg("--tounicode=1")
        .arg("input.pdf")
        .arg("output.html")
        .output()
        .c(h!())?;
    anyhow::ensure!(
        output.status.success(),
        "pdf2htmlEX exited with {}",
        output.status
    );
    let file_res = String::from_utf8_lossy(
        &std::fs::read(output_html.clone()).context(format!(
            "{} {}",
            output_html.display(),
            h!()
        ))?,
    )
    .to_string();
    Ok(file_res)
}

pub fn oneoff_terminal_pdf_extract() -> Result<(), AppError> {
    let file = Path::new("data/report_2022-11-01_22-02-38_01112022-Ж1.pdf");
    let txt = pdf_to_text(file)?;
    println!("> txt: {txt}");
    Ok(())
}

// fn extract_titles(inp: &str) -> Result<BTreeMap<u64, String>, AppError> {
//     let mut res = BTreeMap::new();

//     lazy_static! {
//         static ref RE: Regex =
//             Regex::new(r"^\s*(?P<num>\d+)\)\. (?P<title>[^(]+) \(.*").unwrap();
//     }
//     for line in inp.lines() {
//         if let Some(capts) = RE.captures(line) {
//             let num: u64 =
//                 capts.name("num").ok_or("no num")?.as_str().parse()?;
//             let title_s = capts.name("title").ok_or("no title")?.as_str();
//             res.insert(num, title_s.to_string());
//         }
//     }

//     Ok(res)
// }

#[derive(Debug, PartialEq, Clone)]
pub struct ReportItem {
    pub num: u64,
    pub title: String,
    pub description: String,
    pub category_short: String,
    pub coord_wgs84: (f64, f64),
}

pub fn extract_items(inp: &str) -> Result<Vec<ReportItem>, AppError> {
    let mut res = vec![];

    lazy_static! {
        static ref RE: Regex =
            Regex::new(r"(?m)^\s*(?P<num>\d+)\)\. ?(?P<title>.*)(.|\n)*?\n\s*Опис: ?(?P<description>(.|\n)*?)\nТип: (?P<category_short>(.|\n)*?) - (.|\n)*?WGS-84: (?P<lat>[\d.]+), (?P<lng>[\d.]+)").unwrap();
    }

    for caps in RE.captures_iter(inp) {
        let num = caps.name("num").ok_or("no num")?.as_str().parse().c(h!())?;
        let title = trim_lines(caps.name("title").ok_or("no title")?.as_str());
        let description =
            trim_lines(caps.name("description").ok_or("no name")?.as_str());
        let category_short = caps
            .name("category_short")
            .ok_or("no cat")?
            .as_str()
            .to_string();
        let lat: f64 =
            caps.name("lat").ok_or("no lat")?.as_str().parse().c(h!())?;
        let lng: f64 =
            caps.name("lng").ok_or("no lng")?.as_str().parse().c(h!())?;
        res.push(ReportItem {
            num,
            title,
            description,
            category_short,
            coord_wgs84: (lat, lng),
        });
    }

    Ok(res)
}

#[cfg(feature = "opencv")]
fn contour_to_rect(
    contour: &opencv::core::Vector<opencv::core::Point>,
) -> Result<opencv::core::Rect, AppError> {
    let mut min_x = 100000000;
    let mut max_x = 0;
    let mut min_y = 100000000;
    let mut max_y = 0;
    for p in contour.iter() {
        if p.x < min_x {
            min_x = p.x;
        }
        if p.y < min_y {
            min_y = p.y;
        }
        if p.x > max_x {
            max_x = p.x;
        }
        if p.y > max_y {
            max_y = p.y;
        }
    }
    if max_x > min_x && max_y > min_y {
        Ok(opencv::core::Rect_ {
            x: min_x,
            y: min_y,
            width: max_x - min_x,
            height: max_y - min_y,
        })
    } else {
        Err(AppError::BL {
            msg: format!("failed extracting rect from contour {contour:?}"),
        })
    }
}

/// We skip these
#[cfg(feature = "opencv")]
fn is_whitey(
    im: &opencv::core::Mat,
    contour: &opencv::core::Vector<opencv::core::Point>,
) -> Result<bool, AppError> {
    if let Ok(rec) = contour_to_rect(contour) {
        let area: u64 = rec.width as u64 * rec.height as u64;
        let roi = opencv::core::Mat::roi(im, rec).c(h!())?;
        let mut num_whites: u64 = 0;
        for (_point, val) in roi.iter().c(h!())? {
            // let point: opencv::core::Point = point;
            let val: u8 = val;
            if val == 255 {
                num_whites += 1;
            }
            if num_whites >= area / 2 {
                return Ok(true);
            }
            // println!("{}", val);
        }
    }
    Ok(false)
}

#[cfg(feature = "opencv")]
pub fn cut_out_photo(in_path: &str, out_path: &str) -> Result<(), AppError> {
    let im =
        opencv::imgcodecs::imread(in_path, opencv::imgcodecs::IMREAD_COLOR)
            .c(h!())?;
    let mut im2 = opencv::core::Mat::default();
    opencv::imgproc::cvt_color_def(
        &im,
        &mut im2,
        opencv::imgproc::COLOR_BGR2GRAY,
    )
    .c(h!())?;
    let mut im3 = opencv::core::Mat::default();
    opencv::imgproc::threshold(&im2, &mut im3, 150.0, 255.0, 0).c(h!())?;
    let mut contours: opencv::core::Vector<
        opencv::core::Vector<opencv::core::Point>,
    > = opencv::core::Vector::default();
    opencv::imgproc::find_contours(
        &im3,
        &mut contours,
        opencv::imgproc::RETR_TREE,
        opencv::imgproc::CHAIN_APPROX_SIMPLE,
        opencv::core::Point2i::default(),
    )
    .c(h!())?;
    let mut cont_and_area = vec![];
    for contour in contours.iter() {
        // println!("> contour: {:?}", contour);
        if !is_whitey(&im3, &contour).c(h!())? {
            let area =
                opencv::imgproc::contour_area(&contour, false).c(h!())?;
            // if area > 200000.0 && area < 1000000.0 {
            if area > 20000.0 {
                cont_and_area.push((contour.clone(), area));
            }
        }
    }
    cont_and_area.sort_by(|b, a| a.1.partial_cmp(&b.1).unwrap());

    let img_contour = &cont_and_area
        .first()
        .ok_or("couldn't find one contour that fits")?
        .0;
    // println!("second-largest contour: {:?}", img_contour);
    let min_x: i32 = img_contour.iter().map(|v| v.x).min().unwrap_or(0);
    let max_x: i32 = img_contour.iter().map(|v| v.x).max().unwrap_or(0);
    let min_y: i32 = img_contour.iter().map(|v| v.y).min().unwrap_or(0);
    let max_y: i32 = img_contour.iter().map(|v| v.y).max().unwrap_or(0);
    let im4 = opencv::core::Mat::roi(
        &im,
        opencv::core::Rect {
            x: min_x,
            y: min_y,
            width: max_x - min_x,
            height: max_y - min_y,
        },
    )
    .c(h!())?;
    opencv::imgcodecs::imwrite(
        out_path,
        &im4,
        &opencv::core::Vector::default(),
    )
    .c(h!())?;
    Ok(())
}

#[cfg(feature = "opencv")]
pub fn oneoff_test_opencv() -> Result<(), AppError> {
    // cut_out_photo("data/bg4.png", "data/bg4-cropped.png")?;
    cut_out_photo(
        "data/bg1b.png",
        "/Users/kon/tmp/wdintel-persist/bg1b-cropped.png",
    )?;
    // cut_out_photo(
    //     "data/report_2022-11-01_22-02-38_01112022-Ж1/bg5.png",
    //     "data/report_2022-11-01_22-02-38_01112022-Ж1/bg5-cropped.png",
    // )?;
    Ok(())
}

// Stub implementations when OpenCV feature is disabled
#[cfg(not(feature = "opencv"))]
pub fn cut_out_photo(in_path: &str, out_path: &str) -> Result<(), AppError> {
    warn!("opencv feature disabled; preserving the original report image");
    std::fs::copy(in_path, out_path).c(h!())?;
    Ok(())
}

#[cfg(not(feature = "opencv"))]
pub fn oneoff_test_opencv() -> Result<(), AppError> {
    warn!("opencv feature disabled; oneoff_test_opencv is a no-op");
    Ok(())
}

#[post("/api/importer/parse-terminal-pdf")]
async fn parse_terminal_pdf(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    _http_req: HttpRequest,
) -> Result<actix_web::HttpResponse, AppError> {
    ensure_basic_role(&env.dbx, &user).await.c(h!())?;
    // Previously generated a presigned GET; now omitted.
    // Public assets can be accessed via their HTTPS URLs directly.

    Ok(
        actix_web::HttpResponseBuilder::new(actix_web::http::StatusCode::OK)
            .body("ok"),
    )
}

pub fn get_images_per_num(
    html: &str,
    items: &Vec<ReportItem>,
) -> Result<BTreeMap<u64, Vec<String>>, AppError> {
    let mut curr_item_num = 1;
    let mut images_per_num: BTreeMap<u64, Vec<String>> = BTreeMap::new();
    let mut results_header_seen = false;
    let document = Document::from(html);
    document
        .select("div[data-page-no]")
        .iter()
        .for_each(|selection| {
            // println!("> data-page-no selection");
            for div in selection.iter() {
                // println!("> data-page-no selection div. attr: {:?}", div.attr("data-page-no"));
                if let Some(_page_num) = div.attr("data-page-no") {
                    // println!("div page={}", page_num);
                    let c1 = div.children().first();
                    for c2 in c1.children().iter() {
                        if c2.text().contains("Результати виконання завдання") {
                            // println!("> result_header_seen");
                            results_header_seen = true;
                        }
                        if results_header_seen {
                            // println!("> c2.text: {}", c2.text());
                            let text_trimmed = c2.text();
                            let text_trimmed = text_trimmed.trim();
                            for item in items.iter() {
                                if text_trimmed
                                    .starts_with(&format!("{}). {}", item.num, item.title))
                                {
                                    println!("> switching to item {}", item.num);
                                    if item.num != curr_item_num + 1 {
                                        eprintln!("> warning! switching to item number that's not old+1. old: {}, new: {}", curr_item_num, item.num);
                                    }
                                    curr_item_num = item.num;
                                }
                            }
                        }
                    }
                    if results_header_seen {
                        // println!("> if let c2");
                        if let Some(c2) = c1.children().first().get(0) {
                            // println!("> c2 {:?} {:?}", c2, c2.node_name());
                            if c2.node_name() == Some("img".into()) {
                                if let Some(src) = c2.attr("src") {
                                    // println!("> found image. src={}", src);
                                    match images_per_num.get_mut(&curr_item_num) {
                                        None => {
                                            images_per_num.insert(curr_item_num, vec![src.clone().into()]);
                                        }
                                        Some(xs) => {
                                            xs.push(src.clone().to_string());
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        });
    Ok(images_per_num)
}

pub fn oneoff_parse_html() -> Result<(), AppError> {
    let txt = std::fs::read_to_string(
        "data/report_2022-11-01_22-02-38_01112022-Ж1.txt",
    )?;
    let items = extract_items(&txt)?;
    let html = std::fs::read_to_string(
        "data/report_2022-11-01_22-02-38_01112022-Ж1/index.html",
    )?;
    let images_per_num = get_images_per_num(&html, &items)?;
    println!("> gathered images: {images_per_num:?}");
    Ok(())
}

fn s3_upload_ctx(
    env: &Env,
) -> Result<(storage::S3Config, opendal::Operator), AppError> {
    let (Some(config), Some(op)) = (env.s3_config.clone(), env.s3.clone())
    else {
        return Err(AppError::BL {
            msg: "s3 storage is not configured".to_string(),
        });
    };
    Ok((config, op))
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UploadScreenshotRes {
    pub image_url: String,
}

#[put("/api/terminal/upload-screenshot")]
pub async fn upload_screenshot(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
) -> Result<Json<UploadScreenshotRes>, AppError> {
    ensure_basic_role(&env.dbx, &user).await.c(h!())?;
    let (s3_config, s3_operator) = s3_upload_ctx(env.as_ref())?;

    let (field, val) = multipart::extract(&mut payload).await.c(h!())?;

    let uuid = Uuid::new_v4().to_string();
    let content_type: String = field
        .content_type()
        .map(|x| x.to_string())
        .unwrap_or("image/jpeg".to_string());
    let ext = (if field.name().is_some_and(|name| name.ends_with(".png"))
        || content_type.to_string().contains("png")
    {
        "png"
    } else {
        "jpg"
    })
    .to_string();
    let filename = format!("report2kmz/{uuid}.{ext}");
    let remote_key = s3_config.prefixed_key(&filename);
    crate::aws::s3_put_object(
        &s3_operator,
        &s3_config.bucket,
        &remote_key,
        val,
        &content_type,
    )
    .await
    .c(h!())?;
    Ok(Json(UploadScreenshotRes {
        image_url: storage::object_url(&s3_config, &remote_key),
    }))
}

#[derive(
    Elm, ElmEncode, ElmDecode, Debug, Serialize, Deserialize, PartialEq, Clone,
)]
pub struct UploadPdfRes {
    pub rows: Vec<RowInfo>,
}

#[put("/api/terminal/upload-pdf")]
pub async fn upload_pdf(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    mut payload: Multipart,
    admission: crate::utils::multipart_admission::MultipartAdmission,
) -> Result<Json<UploadPdfRes>, AppError> {
    ensure_basic_role(&env.dbx, &user).await.c(h!())?;
    let (s3_config, s3_operator) = s3_upload_ctx(env.as_ref())?;

    let (_, val) = multipart::extract(&mut payload).await.c(h!())?;

    let tmp_dir = Arc::new(TempDir::new()?);
    let tmp_dir2 = tmp_dir.clone();
    let input_pdf = tmp_dir.path().join("input.pdf");
    println!("> upload_pdf writing into {}", input_pdf.display());
    std::fs::write(&input_pdf, val)?;
    println!("> beginning pdf_to_text");
    let text_dir = tmp_dir.clone();
    let text_admission = admission.clone();
    let txt: String = tokio::task::spawn_blocking(move || {
        let _admission = text_admission;
        pdf_to_text(&text_dir.path().join("input.pdf"))
    })
    .await
    .c(h!())??;
    let items = extract_items(&txt)?;
    println!("> extracted items: {}", items.len());
    println!("> beginning pdf_to_html");
    let html: String = tokio::task::spawn_blocking(move || {
        let _admission = admission;
        pdf_to_html(tmp_dir2.path())
    })
    .await
    .c(h!())??;
    println!("> done doing pdf_to_html");
    println!("> getting images_per_num");
    let images_per_num = get_images_per_num(&html, &items)?;
    println!("> gathered images: {images_per_num:?}");
    println!("> stripping images now");
    let mut images_per_num2 = BTreeMap::new();
    let mut prepared_images = std::collections::BTreeSet::new();

    crate::utils::backup_tmp_dir(tmp_dir.path())?;

    for (num, images) in images_per_num.iter() {
        let mut images2 = vec![];
        for image_name in images.iter() {
            let image =
                format!("{}", tmp_dir.path().join(image_name).display());
            println!("> processing {image}");
            let im_out = format!("{image}-cropped.png");
            if prepared_images.insert(image.clone()) {
                cut_out_photo(&image, &im_out).context(h!())?;
            }
            images2.push(im_out.clone());
        }
        images_per_num2.insert(num, images2);
    }
    println!("> uploading images now");
    let mut image_urls_per_num: BTreeMap<u64, Vec<String>> = BTreeMap::new();
    for (num, images) in images_per_num2.iter() {
        let mut urls = vec![];
        for image in images.iter() {
            let uuid = Uuid::new_v4().to_string();
            let filename = format!("report2kmz/{uuid}.png");
            let mut upload_futures = vec![];
            {
                let img_bytes = std::fs::read(image).c(h!())?;
                let image_path = image.clone();
                let s3_config = s3_config.clone();
                let s3_operator = s3_operator.clone();
                let remote_key = s3_config.prefixed_key(&filename);
                let upload = async move {
                    println!("> uploading {image_path}");
                    crate::aws::s3_put_object(
                        &s3_operator,
                        &s3_config.bucket,
                        &remote_key,
                        img_bytes,
                        "image/png",
                    )
                    .await
                    .c(h!())?;
                    Ok::<String, AppError>(storage::object_url(
                        &s3_config,
                        &remote_key,
                    ))
                };
                upload_futures.push(upload);
            }
            for res in futures::future::join_all(upload_futures).await {
                urls.push(res?);
            }
        }
        image_urls_per_num.insert(**num, urls);
    }
    println!("> upload done");

    let mut rows = vec![];
    for item in items.iter() {
        let urls: Vec<String> = match image_urls_per_num.get(&item.num) {
            None => vec![],
            Some(vs) => vs.to_vec(),
        };
        rows.push(RowInfo {
            content: item.description.clone(),
            image_urls: urls,
            lat: format!("{:.6}", item.coord_wgs84.0),
            lng: format!("{:.6}", item.coord_wgs84.1),
            title: item.title.clone(),
            icon: "00_Загально.png".to_string(),
        });
    }

    println!(
        "> returning result: \n{}",
        serde_json::to_string(&rows).c(h!())?
    );

    Ok(Json(UploadPdfRes { rows }))
}

/// | Test upload_pdf api as much as possible
pub async fn oneoff_test_full_circle() -> Result<(), AppError> {
    let tmp_dir = Arc::new(TempDir::new()?);
    let tmp_dir2 = tmp_dir.clone();
    let input_pdf = tmp_dir.path().join("input.pdf");

    std::fs::copy(
        Path::new("data/2022-12-21-report_2022-12-21_00-37-05_20122022-В1.pdf"),
        &input_pdf,
    )?;

    println!("> beginning pdf_to_text");
    let txt: String =
        tokio::task::spawn_blocking(move || pdf_to_text(&input_pdf))
            .await
            .c(h!())??;
    let items = extract_items(&txt)?;
    println!("> extracted items: {}", items.len());
    println!("> beginning pdf_to_html");
    let html: String =
        tokio::task::spawn_blocking(move || pdf_to_html(tmp_dir2.path()))
            .await
            .c(h!())??;
    println!("> done doing pdf_to_html");
    println!("> getting images_per_num");
    let images_per_num = get_images_per_num(&html, &items)?;
    println!("> gathered images: {images_per_num:?}");
    println!("> stripping images now");
    let mut images_per_num2 = BTreeMap::new();

    crate::utils::backup_tmp_dir(tmp_dir.path())?;

    for (num, images) in images_per_num.iter() {
        let mut images2 = vec![];
        for image_name in images.iter() {
            let image =
                format!("{}", tmp_dir.path().join(image_name).display());
            println!("> processing {image}");
            let im_out = format!("{image}-cropped.png");
            if let Err(e) = cut_out_photo(&image, &im_out) {
                println!(
                    "> error while cropping {image}, skipping. error: {e:?}"
                );
            };
            images2.push(im_out.clone());
        }
        images_per_num2.insert(num, images2);
    }

    Ok(())
}

// taken from pdf2htmlEX/pdf2htmlEX/src/util/encoding.cc
pub fn map_utf8(u: u32) -> (i64, Vec<u8>) {
    let mut buf: Vec<u8> = vec![];
    if u <= 0x0000007f {
        buf.push(u as u8);
        return (1, buf);
    } else if u <= 0x000007ff {
        buf.push(0xc0 + (u >> 6) as u8);
        buf.push(0x80 + (u & 0x3f) as u8);
        return (2, buf);
    } else if u <= 0x0000ffff {
        buf.push(0xe0 + (u >> 12) as u8);
        buf.push(0x80 + ((u >> 6) & 0x3f) as u8);
        buf.push(0x80 + (u & 0x3f) as u8);
        return (3, buf);
    } else if u <= 0x0010ffff {
        buf.push(0xf0 + (u >> 18) as u8);
        buf.push(0x80 + ((u >> 12) & 0x3f) as u8);
        buf.push(0x80 + ((u >> 6) & 0x3f) as u8);
        buf.push(0x80 + (u & 0x3f) as u8);
        return (4, buf);
    }
    (0, buf)
}

pub fn as_u32_be(array: &[u8; 4]) -> u32 {
    ((array[0] as u32) << 24)
        + ((array[1] as u32) << 16)
        + ((array[2] as u32) << 8)
        + (array[3] as u32)
}

pub fn as_u32_le(array: &[u8; 4]) -> u32 {
    (array[0] as u32)
        + ((array[1] as u32) << 8)
        + ((array[2] as u32) << 16)
        + ((array[3] as u32) << 24)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;

    #[test]
    fn test_my_regex_knowledge() {
        lazy_static! {
            static ref RE: Regex =
                Regex::new(r"(?m)^\s*(?P<num>\d+)\)\. (?P<title>.*)\nОпис: (?P<description>.*)").unwrap();
        }
        let mut res = vec![];
        let inp = r###"8). one
Опис: one

8). two
Опис: two
"###;
        for caps in RE.captures_iter(inp) {
            res.push(caps.name("title").unwrap().as_str().to_string());
        }
        assert_eq!(res, vec!["one".to_string(), "two".to_string()]);
    }

    //     #[test]
    //     fn extract_titles_ex01() {
    //         let input = r###"
    // 1). Камаз (КамАЗ-4350 (4х4) - Позашляхова вантажівка Допоміжні засоби - Окреме обладнання)
    // 2). ВАТ (ВАТ (військова автомобільна техніка) - Позашляхова
    // вантажівка - Допоміжні засоби - Окреме обладнання)
    // 3). О/с (Піхота - Служба / Відділення - Військовий - Окремі бійці)
    // 4). ВАТ (ВАТ (військова автомобільна техніка) - Позашляхова
    // вантажівка - Допоміжні засоби - Окреме обладнання)
    // 5). ВАТ (ВАТ (військова автомобільна техніка) - Позашляхова
    // вантажівка - Допоміжні засоби - Окреме обладнання)
    // 6). Су-25 (Су-25 - Атакуючий/Ударний - Літак з фіксованим
    // крилом - Військовий - Повітряні об`єкти)
    // 7). ВАТ (ВАТ (військова автомобільна техніка) - Позашляхова
    // вантажівка - Допоміжні засоби - Окреме обладнання)
    // 8). ББМ (Інша ББМ - ББМ (Броньована бойова машина) Броньований транспорт - Транспортні засоби - Окреме
    // обладнання)
    // 9). КамАЗ (КамАЗ-4350 (4х4) - Позашляхова вантажівка Допоміжні засоби - Окреме обладнання)
    // 10). БМД (Інша БМД - ББМ (Броньована бойова машина) Броньований транспорт - Транспортні засоби - Окреме
    // обладнання)
    // 11). БМД (Інша БМД - ББМ (Броньована бойова машина) Броньований транспорт - Транспортні засоби - Окреме
    // обладнання)
    // 12). ББМ (Інша ББМ - ББМ (Броньована бойова машина) Броньований транспорт - Транспортні засоби - Окреме
    // обладнання)
    // 13). ББМ (Інша ББМ - ББМ (Броньована бойова машина) Броньований транспорт - Транспортні засоби - Окреме
    // обладнання)
    // 14). ББМ з координат X=5220107, Y=6551341 (Інша ББМ - ББМ
    // (Броньована бойова машина) - Броньований транспорт Транспортні засоби - Окреме обладнання)
    // 15). ВАТ (ВАТ (військова автомобільна техніка) - Позашляхова
    // вантажівка - Допоміжні засоби - Окреме обладнання)
    // 1 / 48

    // 16). ВАТ (ВАТ (військова автомобільна техніка) - Позашляхова
    // вантажівка - Допоміжні засоби - Окреме обладнання)
    // 17). ББМ (Інша ББМ - ББМ (Броньована бойова машина) Броньований транспорт - Транспортні засоби - Окреме
    // обладнання)
    // 18). Су-25 (Су-25 - Атакуючий/Ударний - Літак з фіксованим
    // крилом - Військовий - Повітряні об`єкти)
    // 19). Су-25 з координат X=5220402, Y=6550862 (Су-25 Атакуючий/Ударний - Літак з фіксованим крилом - Військовий Повітряні об`єкти)
    // 20). Су-25 з координат X=5220402, Y=6550862 (Су-25 Атакуючий/Ударний - Літак з фіксованим крилом - Військовий Повітряні об`єкти)
    // 21). ВАТ (ВАТ (військова автомобільна техніка) - Позашляхова
    // вантажівка - Допоміжні засоби - Окреме обладнання)
    // 22). БТР (Інший бронетранспортер - Бронетранспортер Броньований транспорт - Транспортні засоби - Окреме
    // обладнання)
    // Рапорт створено
    // "###;
    //         assert_eq!(
    //             Vec::from_iter(
    //                 extract_titles(input)
    //                     .unwrap()
    //                     .iter()
    //                     .map(|(x, y)| (x.clone(), y.clone()))
    //             ),
    //             vec![
    //                 (1, "Камаз".to_string()),
    //                 (2, "ВАТ".to_string()),
    //                 (3, "О/с".to_string()),
    //                 (4, "ВАТ".to_string()),
    //                 (5, "ВАТ".to_string()),
    //                 (6, "Су-25".to_string()),
    //                 (7, "ВАТ".to_string()),
    //                 (8, "ББМ".to_string()),
    //                 (9, "КамАЗ".to_string()),
    //                 (10, "БМД".to_string()),
    //                 (11, "БМД".to_string()),
    //                 (12, "ББМ".to_string()),
    //                 (13, "ББМ".to_string()),
    //                 (14, "ББМ з координат X=5220107, Y=6551341".to_string()),
    //                 (15, "ВАТ".to_string()),
    //                 (16, "ВАТ".to_string()),
    //                 (17, "ББМ".to_string()),
    //                 (18, "Су-25".to_string()),
    //                 (19, "Су-25 з координат X=5220402, Y=6550862".to_string()),
    //                 (20, "Су-25 з координат X=5220402, Y=6550862".to_string()),
    //                 (21, "ВАТ".to_string()),
    //                 (22, "БТР".to_string()),
    //             ]
    //         )
    //     }

    #[test]
    fn extract_items_ex01_simp() {
        let input = r###"
8). ББМ
Опис: рухався в південно- східному напрямку, в лісопосадку.
Тип: Інша ББМ - ББМ (Броньована бойова
машина) - Броньований транспорт Транспортні засоби - Окреме обладнання
Ворожість: Ворожий
Координати

WGS-84: 47.134208, 33.694301
WGS-84 DMS: N47°8'3.15", E33°41'39.48"
СК-42: X=5222512, Y=6552792
UTM: Z: 36T, E: 552652, N: 5220312
MGRS: 36TWT5265220312

Нас. пункти

5.55 км на північний захід від Качкарівка
(Бериславський / Херсонська)
6.00 км на захід від Саблуківка
(Бериславський / Херсонська)
8.94 км на північний схід від Милове
(Бериславський / Херсонська)

Висота

70 м (AMSL)

Оновлено

2022-11-01 19:42:21 (pc1)

[2022-11-01 19:42:21]

18 / 48

[2022-11-01 19:42:22]

19 / 48

9). КамАЗ
Опис: рухався з н.п. Милове в н.п. Качкарівка.
Тип: КамАЗ-4350 (4х4) - Позашляхова
вантажівка - Допоміжні засоби - Окреме
обладнання
Ворожість: Ворожий
Координати

WGS-84: 47.124518, 33.702061
WGS-84 DMS: N47°7'28.27", E33°42'7.42"
СК-42: X=5221440, Y=6553390
UTM: Z: 36T, E: 553250, N: 5219241
MGRS: 36TWT5325019241

Нас. пункти

4.36 км на північний захід від Качкарівка
(Бериславський / Херсонська)
5.29 км на захід від Саблуківка
(Бериславський / Херсонська)
8.41 км на північний схід від Милове
(Бериславський / Херсонська)

Висота

64 м (AMSL)

Оновлено

2022-11-01 19:50:14 (pc1)

[2022-11-01 19:50:15]

20 / 48

[2022-11-01 19:50:15]

21 / 48
"###;

        assert_eq!(
            Vec::from_iter(extract_items(input).unwrap()),
            vec![
                ReportItem {
                    num: 8,
                    title: "ББМ".to_string(),
                    description:
                        "рухався в південно- східному напрямку, в лісопосадку."
                            .to_string(),
                    category_short: "Інша ББМ".to_string(),
                    coord_wgs84: (47.134208, 33.694301),
                },
                ReportItem {
                    num: 9,
                    title: "КамАЗ".to_string(),
                    description: "рухався з н.п. Милове в н.п. Качкарівка."
                        .to_string(),
                    category_short: "КамАЗ-4350 (4х4)".to_string(),
                    coord_wgs84: (47.124518, 33.702061),
                }
            ]
        )
    }

    #[test]
    fn extract_items_ex01_second() {
        let input = r###"
2). ВАТ
Опис: ВАТ-2 од.
рухались з н.п. Милове в північному напрямку.
Тип: ВАТ (військова автомобільна техніка) Позашляхова вантажівка - Допоміжні
засоби - Окреме обладнання
Ворожість: Ворожий
Координати

WGS-84: 47.081317, 33.646027
"###;

        assert_eq!(
            Vec::from_iter(extract_items(input).unwrap()),
            vec![ReportItem {
                num: 2,
                title: "ВАТ".to_string(),
                description:
                    "ВАТ-2 од.\nрухались з н.п. Милове в північному напрямку."
                        .to_string(),
                category_short: "ВАТ (військова автомобільна техніка) Позашляхова вантажівка".to_string(),
                coord_wgs84: (47.081317, 33.646027),
            }]
        )
    }

    #[test]
    fn extract_items_ex01_fourth() {
        let input = r###"
4). ВАТ
Опис:
Тип: ВАТ (військова автомобільна техніка) Позашляхова вантажівка - Допоміжні
засоби - Окреме обладнання
Ворожість: Ворожий
Координати

WGS-84: 47.161249, 33.718252
"###;

        assert_eq!(
            Vec::from_iter(extract_items(input).unwrap()),
            vec![ReportItem {
                num: 4,
                title: "ВАТ".to_string(),
                description:"".to_string(),
                category_short: "ВАТ (військова автомобільна техніка) Позашляхова вантажівка".to_string(),
                coord_wgs84: (47.161249, 33.718252),
            }]
        )
    }

    #[cfg(not(feature = "opencv"))]
    #[test]
    fn photo_fallback_preserves_image_and_reports_missing_source() {
        let directory = TempDir::new().unwrap();
        let input = directory.path().join("input.png");
        let output = directory.path().join("output.png");
        let source = include_bytes!("../../data/report_2022-11-01_22-02-38_01112022-Ж1/pdf2htmlEX-64x64.png");
        std::fs::write(&input, source).unwrap();
        for _ in 0..2 {
            cut_out_photo(input.to_str().unwrap(), output.to_str().unwrap())
                .unwrap();
            assert_eq!(std::fs::read(&output).unwrap(), source);
        }
        std::fs::remove_file(&input).unwrap();
        assert!(cut_out_photo(
            input.to_str().unwrap(),
            output.to_str().unwrap()
        )
        .is_err());
    }

    #[test]
    #[ignore = "requires real pdftotext and pdf2htmlEX executables"]
    #[serial]
    fn concurrent_pdf_conversions_preserve_process_directory() {
        let working_dir = std::env::current_dir().unwrap();
        let source = working_dir.join("data/report21082022-2FOX.pdf");
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let mut tasks = Vec::new();
        for _ in 0..2 {
            let source = source.clone();
            let barrier = barrier.clone();
            tasks.push(std::thread::spawn(move || {
                let directory = TempDir::new().unwrap();
                std::fs::copy(source, directory.path().join("input.pdf"))
                    .unwrap();
                barrier.wait();
                let text =
                    pdf_to_text(&directory.path().join("input.pdf")).unwrap();
                let html = pdf_to_html(directory.path()).unwrap();
                assert!(!text.is_empty());
                assert!(html.contains("pdf2htmlEX"));
                assert!(directory.path().join("output.html").is_file());
                (text.len(), html.len())
            }));
        }
        barrier.wait();
        let mut unchanged = true;
        while tasks.iter().any(|task| !task.is_finished()) {
            unchanged &= std::env::current_dir().unwrap() == working_dir;
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        let sizes: Vec<_> =
            tasks.into_iter().map(|task| task.join().unwrap()).collect();
        assert!(
            unchanged,
            "PDF subprocess changed the API process directory"
        );
        assert_eq!(std::env::current_dir().unwrap(), working_dir);
        assert_eq!(sizes[0].0, sizes[1].0);
    }

    #[test]
    #[ignore]
    #[serial]
    fn extract_items_ex01_len() {
        let txt = pdf_to_text(Path::new(
            "data/report_2022-11-01_22-02-38_01112022-Ж1.pdf",
        ))
        .unwrap();
        let report_items = extract_items(&txt).unwrap();
        let nums: Vec<u64> = report_items.iter().map(|x| x.num).collect();
        println!("{nums:?}");
        assert_eq!(report_items.len(), 22);
    }

    #[test]
    #[ignore]
    #[serial]
    fn extract_items_ex02_len() {
        let workdir = std::env::current_dir().unwrap();
        println!("> workdir: {workdir:?}");
        let txt = pdf_to_text(Path::new("data/19.36 07.11.2022.pdf")).unwrap();
        let report_items = extract_items(&txt).unwrap();
        let nums: Vec<u64> = report_items.iter().map(|x| x.num).collect();
        println!("{nums:?}");
        assert_eq!(report_items.len(), 136);
    }

    #[ignore]
    #[test]
    fn extract_items_ex02_42() {
        let input = r###"
41). Скупчення ОС
37 / 102

Опис: 06.11.22 Скупчення живої сили РОВ 200 од.
Тип: Скупчення ОС - Піхота - Пересування і маневри - Наземні
підрозділи
Ворожість: Ворожий
Координати

WGS-84: 46.370715, 34.328642
WGS-84 DMS: N46°22'14.57", E34°19'43.11"
СК-42: X=51-38261, Y=66-02350
UTM: Z: 36T, E: 602190, N: 5136095
MGRS: 36TXS0219036095

Нас. пункти

2.21 км на північ від Новотроїцьке (Новотроїцький / Херсонська)
6.07 км на захід від Олександрівка (Новотроїцький / Херсонська)
10.78 км на південь від Метрополь (Новотроїцький / Херсонська)

Висота

21 м (AMSL)

Оновлено

2022-11-07 16:22:54 (user3)

42). Склад озброєння та боєприпасів
Опис: 18.10.22 Склад БК та палива РОВ
РО Доц: 47.072448, 33.646353 18.10. 11:00 розташовується склад БК та палива, особовий склад та РЗСО «ГРАД», які ведуть обстріли позицій
ЗСУ у районі н/п Дудчани, перезарядку також проводять на вказаній території, н/п Милове
Тип: Склад боєприпасів - Військове призначення - Будівлі
Ворожість: Ворожий
Координати

WGS-84: 47.072448, 33.646353
"###;

        assert_eq!(
            Vec::from_iter(extract_items(input).unwrap()),
            vec![
                ReportItem {
                    num: 41,
                    title: "Скупчення ОС".to_string(),
                    description: "06.11.22 Скупчення живої сили РОВ 200 од.".to_string(),
                    category_short: "Скупчення ОС".to_string(),
                    coord_wgs84: (46.370715, 34.328642),
                },
                ReportItem {
                    num: 42,
                    title: "Склад озброєння та боєприпасів".to_string(),
                    description: "18.10.22 Склад БК та палива РОВ
РО Доц: 47.072448, 33.646353 18.10. 11:00 розташовується склад БК та палива, особовий склад та РЗСО «ГРАД», які ведуть обстріли позицій
ЗСУ у районі н/п Дудчани, перезарядку також проводять на вказаній території, н/п Милове".to_string(),
                    category_short: "Склад боєприпасів".to_string(),
                    coord_wgs84: (47.072448, 33.646353),
                }
            ]
        )
    }

    #[ignore]
    #[test]
    fn extract_items_ex02_90() {
        let input = r###"
90). Управління військами (C2)

Опис: 08.10 06.11.2022 Розташований штаб сил РОВ кількістю приблизно 40 осіб. На подвір'ї стоїть 1 БТР.
Тип: Управління військами (C2) - Наземні підрозділи
Ворожість: Ворожий
Координати

WGS-84: 47.757013, 37.233638
"###;

        assert_eq!(
            Vec::from_iter(extract_items(input).unwrap()),
            vec![ReportItem {
                num: 90,
                title: "Управління військами (C2)".to_string(),
                description: "08.10 06.11.2022 Розташований штаб сил РОВ кількістю приблизно 40 осіб. На подвір'ї стоїть 1 БТР.".to_string(),
                category_short: "Управління військами (C2)".to_string(),
                coord_wgs84: (47.757013, 37.233638),
            }]
        )
    }

    #[test]
    fn cleanup_bad_text() {
        let input = std::fs::read_to_string("data/badtext.txt").unwrap();
        assert_eq!(input, "\u{0c}2). ВОП\n".to_string(),);
        assert_eq!(input.replace("\u{0c}", ""), "2). ВОП\n".to_string(),)
    }

    #[test]
    #[ignore]
    #[serial]
    fn extract_items_ex03_len() {
        let txt =
            pdf_to_text(Path::new("data/report21082022-2FOX.pdf")).unwrap();
        std::fs::write(Path::new("data/report21082022-2FOX.txt"), &txt)
            .unwrap();
        let items = extract_items(&txt).unwrap();
        let nums: Vec<u64> = items.iter().map(|x| x.num).collect();
        println!("{nums:?}");
        println!("> item 0 desc: \n{}", items[0].description);
        assert_eq!(items.len(), 14);
    }

    #[tokio::test]
    #[ignore]
    #[serial]
    async fn extract_items_ex04_len() {
        let txt = tokio::task::spawn_blocking(move || {
            pdf_to_text(Path::new(
                "data/report_2023-02-17_00-23-20_16022023.pdf",
            ))
        })
        .await
        .unwrap()
        .unwrap();
        std::fs::write(
            Path::new("data/report_2023-02-17_00-23-20_16022023.txt"),
            &txt,
        )
        .unwrap();
        let items = extract_items(&txt).unwrap();
        let nums: Vec<u64> = items.iter().map(|x| x.num).collect();
        println!("{nums:?}");
        println!("> item 0 desc: \n{}", items[0].description);
        assert_eq!(items.len(), 64);
    }

    #[tokio::test]
    #[ignore]
    #[serial]
    async fn extract_images_test01() {
        let input_pdf =
            Path::new("data/report_2023-02-17_00-23-20_16022023-Ж1-orig.pdf");
        let txt: String =
            tokio::task::spawn_blocking(move || pdf_to_text(input_pdf))
                .await
                .unwrap()
                .unwrap();
        let items = extract_items(&txt).unwrap();
        let html = std::fs::read_to_string("data/report_2023-02-17_00-23-20_16022023-Ж1-orig/report_2023-02-17_00-23-20_16022023-Ж1-orig.html").unwrap();
        let images_per_num = get_images_per_num(&html, &items).unwrap();
        println!(
            "> resulting images_per_num: {}",
            serde_json::to_string(&images_per_num).unwrap()
        );
        let keys = images_per_num.keys();
        assert_eq!(keys.len(), 64);
    }
}
