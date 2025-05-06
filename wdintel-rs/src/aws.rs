use crate::error::AppError;
use aws_sdk_s3::operation::put_object::PutObjectOutput;
use rand::Rng;
use std::time::Duration;

pub async fn s3_put_object(
    b2_cli: &aws_sdk_s3::Client,
    bucket: &str,
    key: &str,
    body: Vec<u8>,
    content_type: &str,
) -> Result<PutObjectOutput, AppError> {
    let mut retries_left: u32 = 2;
    while retries_left > 0 {
        let res = b2_cli
            .put_object()
            .bucket(bucket)
            .key(key)
            .body(aws_sdk_s3::primitives::ByteStream::from(body.clone()))
            .set_content_type(Some(content_type.to_string()))
            .send()
            .await;
        match res {
            Err(e) => {
                retries_left -= 1;
                random_sleep().await;
                if retries_left == 0 {
                    return Err(AppError::from(Box::new(e)));
                }
            }
            Ok(v) => return Ok(v),
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
