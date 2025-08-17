use crate::error::AppError;
use opendal::Operator;
use rand::Rng;
use std::time::Duration;

pub async fn s3_put_object(
    store: &Operator,
    _bucket: &str,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
) -> Result<(), AppError> {
    let mut retries_left: u32 = 2;
    while retries_left > 0 {
        // Use writer_with builder to set content type and write all bytes
        let write_res = async {
            let mut writer =
                store.writer_with(key).content_type(content_type).await?;
            // Write all bytes, then close
            writer.write(body.clone()).await?;
            writer.close().await
        }
        .await;
        let res = write_res;
        match res {
            Err(e) => {
                retries_left -= 1;
                random_sleep().await;
                if retries_left == 0 {
                    return Err(AppError::from(e));
                }
            }
            Ok(_) => return Ok(()),
        }
    }
    Err(AppError::BL {
        msg: "impossible".to_string(),
    })
}

pub async fn random_sleep() {
    let sleep_time: u64 = {
        let mut rng = rand::rng();
        rng.random_range(900..1100)
    };
    tokio::time::sleep(Duration::from_millis(sleep_time)).await;
}
