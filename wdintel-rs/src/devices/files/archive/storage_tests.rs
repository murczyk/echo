use super::storage::Client;
use crate::storage::S3Config;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(super) struct Server {
    pub config: S3Config,
    pub calls: Arc<AtomicUsize>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub(super) async fn server(responses: Vec<(u16, &'static str)>) -> Server {
    server_with_delay(responses, std::time::Duration::ZERO).await
}

pub(super) async fn server_with_delay(
    responses: Vec<(u16, &'static str)>,
    delay: std::time::Duration,
) -> Server {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let received = calls.clone();
    let task = tokio::spawn(async move {
        for (status, body) in responses {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = stream.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                if request.windows(4).any(|part| part == b"\r\n\r\n") {
                    break;
                }
            }
            received.fetch_add(1, Ordering::SeqCst);
            tokio::time::sleep(delay).await;
            let response = format!(
                "HTTP/1.1 {status} response\r\nContent-Type: application/xml\r\nETag: \"fake-part\"\r\nx-amz-meta-source-sha256: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                "03".repeat(32),
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    Server {
        config: S3Config {
            endpoint,
            bucket: "owned-test".to_owned(),
            region: "us-east-1".to_owned(),
            access_key_id: "test".to_owned(),
            secret_access_key: "test".to_owned(),
            prefix: String::new(),
        },
        calls,
        task,
    }
}

#[tokio::test]
async fn archive_multipart_protocol_preserves_upload_id_and_checks_completion_3778(
) {
    let server=server(vec![(200,"<InitiateMultipartUploadResult><UploadId>upload+opaque/id=</UploadId></InitiateMultipartUploadResult>"),(200,"<CompleteMultipartUploadResult><Key>owned/key</Key><ETag>&quot;etag&quot;</ETag></CompleteMultipartUploadResult>")]).await;
    let client = Client::new(&server.config).unwrap();
    let upload = client.create("owned/key", &[3; 32]).await.unwrap();
    assert_eq!(upload, "upload+opaque/id=");
    client
        .complete("owned/key", &upload, &[(1, "\"part\"".to_owned())])
        .await
        .unwrap();
    assert_eq!(server.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn archive_multipart_http_200_error_is_not_publication_3778() {
    let server=server(vec![(200,"<Error><Code>InvalidPart</Code><Message>missing part</Message></Error>")]).await;
    let client = Client::new(&server.config).unwrap();
    assert!(client
        .complete("owned/key", "upload", &[(1, "etag".to_owned())])
        .await
        .is_err());
    assert_eq!(server.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn archive_multipart_abort_retains_debt_while_parts_remain_3778() {
    let server=server(vec![(204,""),(200,"<ListPartsResult><IsTruncated>false</IsTruncated><Part><PartNumber>1</PartNumber><ETag>etag</ETag></Part></ListPartsResult>")]).await;
    let client = Client::new(&server.config).unwrap();
    assert!(client.abort("owned/key", "upload").await.is_err());
    assert_eq!(server.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn archive_multipart_abort_requires_missing_upload_or_empty_parts_3778() {
    for response in [
        (404, "<Error><Code>NoSuchUpload</Code></Error>"),
        (
            200,
            "<ListPartsResult><IsTruncated>false</IsTruncated></ListPartsResult>",
        ),
    ] {
        let server = server(vec![(204, ""), response]).await;
        Client::new(&server.config)
            .unwrap()
            .abort("owned/key", "upload")
            .await
            .unwrap();
        assert_eq!(server.calls.load(Ordering::SeqCst), 2);
    }
    let server = server(vec![
        (204, ""),
        (404, "<Error><Code>NoSuchBucket</Code></Error>"),
    ])
    .await;
    assert!(Client::new(&server.config)
        .unwrap()
        .abort("owned/key", "upload")
        .await
        .is_err());
}

#[tokio::test]
async fn archive_storage_uses_exact_keys_for_parts_discovery_and_cleanup_3778()
{
    let server=server(vec![(200,""),(200,"<ListMultipartUploadsResult><IsTruncated>false</IsTruncated><Upload><Key>owned/key/object</Key><UploadId>ours</UploadId></Upload><Upload><Key>owned/key-neighbor</Key><UploadId>untouched</UploadId></Upload></ListMultipartUploadsResult>"),(200,"A"),(204,""),(404,"")]).await;
    let client = Client::new(&server.config).unwrap();
    assert_eq!(
        client
            .part("owned/key/object", "ours", 1, vec![1])
            .await
            .unwrap(),
        "\"fake-part\""
    );
    assert_eq!(
        client.unfinished("owned/key/").await.unwrap(),
        vec![("owned/key/object".into(), "ours".into())]
    );
    let object = client.head("owned/key/object").await.unwrap().unwrap();
    assert_eq!(object.size, 1);
    assert_eq!(object.source_sha256, "03".repeat(32));
    client.delete("owned/key/object").await.unwrap();
    assert!(client.head("owned/key/object").await.unwrap().is_none());
    assert_eq!(server.calls.load(Ordering::SeqCst), 5);
}
