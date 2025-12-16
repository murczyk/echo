use actix_multipart::Multipart;
use actix_web::{get, post, HttpRequest, HttpResponse};
use futures_util::StreamExt;
use tempfile::TempDir;
use uuid::Uuid;
use crate::error::AppError;
use crate::h;
use crate::kml::oneoff_fix_kml;
use crate::types::{Env, ShortContext};

#[get("/api/alpine/convert")]
async fn convert_alpinequest_file(
    user: actix_identity::Identity,
    env: actix_web::web::Data<Env>,
    http_req: HttpRequest,
    mut payload: Multipart,
) -> Result<HttpResponse, AppError> {
    let login = user.id().c(h!())?;
    crate::users::has_role(&env.dbx, &login, "Rer")
        .await
        .c(h!())?;
    let mut hide_titles: bool = false;
    let mut val = vec![];
    let mut filename: String = "".to_string();

    while let Some(item) = payload.next().await {
        let mut field = item.map_err(|e| -> AppError {
            format!("Multipart error: {e:?}").into()
        })?;
        let field_name = field.name().c(h!())?;
        if field_name == "hide_titles" {
            while let Some(chunk) = field.next().await {
                let v = chunk
                    .map_err(|e| -> AppError {
                        format!("Multipart error: {e:?}").into()
                    })?
                    .to_vec();
                if String::from_utf8(v) == Ok("1".to_string()) {
                    hide_titles = true;
                }
            }
        } else {
            filename = field_name.to_string();
            let mut val_curr: Vec<u8> = vec![];
            while let Some(chunk) = field.next().await {
                val_curr.extend(
                    chunk
                        .map_err(|e| -> AppError {
                            format!("Multipart error: {e:?}").into()
                        })?
                        .to_vec(),
                );
            }
            val = val_curr;
        }
    }
    let tmp_dir = TempDir::new()?;
    println!("> tmp_dir {}", &tmp_dir.path().display());
    let kmz_file = tmp_dir.path().join(filename);
    println!("> kmz_file: {}", &kmz_file.display());
    std::fs::write(&kmz_file, val)?;
    crate::utils::backup_tmp_dir(tmp_dir.path())?;

    let output =
        format!("{}", kmz_file.display()).replace(".kmz", "-fixed.kmz");
    oneoff_fix_kml(
        env.mode,
        &crate::OneoffFixKmzPs {
            kmz: format!("{}", kmz_file.display()),
            res: output.clone(),
            hide_titles,
        },
    )
        .await
        .c(h!())?;
    println!("> output: {}", &output);

    let file = actix_files::NamedFile::open_async(&output).await.c(h!())?;
    Ok(file.into_response(&http_req))
}