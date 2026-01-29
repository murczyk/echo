import json
import os
import urllib.parse
from pathlib import Path

import boto3
import mlflow
import mlflow.artifacts
import pandas as pd
from discord_webhook import DiscordWebhook


def rollback(s3, versions, bucket: str, keys: list[str]):
    dict_versions = {ver["Key"]: ver for ver in versions["Versions"] if ver["IsLatest"]}

    for key in keys:
        latest_version = dict_versions.get(key)
        if latest_version:
            last_modified = latest_version["LastModified"]
            version_id = latest_version["VersionId"]
            print(
                f"restoring {key} to version '{last_modified}', version_id = '{version_id}'"
            )
            copy_source = {"Bucket": bucket, "Key": key, "VersionId": version_id}
            s3.copy_object(Bucket=bucket, Key=key, CopySource=copy_source)
        else:
            print(f"no previous version for {key}, removing")
            s3.delete_object(Bucket=bucket, Key=key)


def upload_artifacts(
    bucket: str, prefix: str, thresholds: dict[str, float], models: dict[str, Path]
):
    s3 = boto3.client("s3")
    versions = s3.list_object_versions(Bucket=bucket, Prefix=prefix)
    uploaded = []
    try:
        for label_name, model_path in models.items():
            object_name = prefix + label_name + ".bin"
            print(f"uploading '{model_path} to bucket {bucket} at {object_name}")
            s3.upload_file(str(model_path), bucket, object_name)
            uploaded.append(object_name)

        key = prefix + "thresholds.json"
        print(f"uploading thresholds to bucket {bucket} at {key}")
        s3.put_object(
            Body=json.dumps(thresholds).encode(),
            ContentType="application/json",
            Bucket=bucket,
            Key=key,
        )
        uploaded.append(key)
    except Exception:
        rollback(s3, versions, bucket, uploaded)
        raise


def get_filter_string(run_id: str):
    return f"tags.mlflow.parentRunId = '{run_id}'"


def discord_notify_success(
    url: str,
    experiment_id: str,
    run_id: str,
    df: pd.DataFrame,
    run_artifacts: Path,
    artifacts: dict[str, Path],
):
    webhook = DiscordWebhook(url=url)
    df.sort_values(by="f1_score", inplace=True, ascending=False)
    table = df[
        ["label_name", "f1_score", "ap", "precision_at_recall", "threshold_at_recall"]
    ]

    run_url_base = os.environ.get(
        "DISCORD_MLFLOW_UI_URL_BASE",
        os.environ.get("MLFLOW_TRACKING_URI", "http://localhost:5000"),
    )
    experiment_id = urllib.parse.quote_plus(experiment_id)
    filter_string = urllib.parse.quote_plus(get_filter_string(run_id))
    run_url = (
        run_url_base
        + f"/#/experiments/{experiment_id}/runs?searchFilter={filter_string}"
    )

    content = f"""
Training run [{run_id}]({run_url}) completed:

```
{table.to_markdown(index=False, floatfmt=".3f")}
```
"""
    print(content)
    webhook.set_content(content)

    for artifact in run_artifacts.glob("*test.png"):
        if artifact.is_file():
            with artifact.open("rb") as f:
                file_name = artifact.name
                webhook.add_file(f.read(), file_name)
                webhook.add_embed({"image": {"url": f"attachment://{file_name}"}})

    # webhook.execute()


def get_report_record(params: dict, metrics: dict):
    return {"label_name": params["label_name"], **metrics}


def upload_run(experiment_id: str, run_id: str, bucket: str, prefix: str):
    filter_string = get_filter_string(run_id)
    runs = mlflow.search_runs(
        experiment_ids=[experiment_id],
        filter_string=filter_string,
        output_format="list",
    )
    run_artifacts = Path(mlflow.artifacts.download_artifacts(run_id=run_id))
    print("run artifacts")
    print(run_artifacts)

    models = {}
    artifacts = {}
    thresholds = {}
    records = []
    for child in runs:
        child_artifacts = Path(
            mlflow.artifacts.download_artifacts(run_id=child.info.run_id)
        )
        for model in child.outputs.model_outputs:
            model = mlflow.get_logged_model(model_id=model.model_id)
            label_name = model.params["label_name"]
            artifacts[label_name] = child_artifacts
            model_dir = Path(
                mlflow.artifacts.download_artifacts(
                    artifact_uri=f"models:/{model.model_id}"
                )
            )
            models[label_name] = model_dir / "model.bin"
            label_metrics = {
                metric.key: metric.value
                for metric in (model.metrics or [])
                if metric.dataset_name and "test" in metric.dataset_name
            }
            record = get_report_record(model.params, label_metrics)
            records.append(record)
            threshold = label_metrics["threshold_at_recall"]
            thresholds[label_name] = threshold

    df = pd.DataFrame.from_records(records)

    # upload_artifacts(bucket, prefix, thresholds, models)
    discord_webhook_url = os.environ.get("DISCORD_WEBHOOK_URL")
    if discord_webhook_url:
        discord_notify_success(
            url=discord_webhook_url,
            experiment_id=experiment_id,
            run_id=run_id,
            run_artifacts=run_artifacts,
            df=df,
            artifacts=artifacts,
        )
