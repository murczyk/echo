import json
import os
import urllib.parse
from pathlib import Path

import boto3
import botocore
import botocore.exceptions
import mlflow
import mlflow.artifacts
import pandas as pd
from discord_webhook import DiscordWebhook
from mlflow.entities import LoggedModelOutput, Run

from echo_ai.registry import TrainedModel


def get_filter_string(run_id: str):
    return f"tags.mlflow.parentRunId = '{run_id}'"


class TrainingResults:
    models: list[TrainedModel]
    artifacts: Path

    def __init__(self, experiment_id: str, run_id: str) -> None:
        self.artifacts = Path(mlflow.artifacts.download_artifacts(run_id=run_id))

        runs = mlflow.search_runs(
            experiment_ids=[experiment_id],
            filter_string=get_filter_string(run_id),
            output_format="list",
        )
        self.models = []
        for run in runs:
            if run.outputs.model_outputs:
                last_model = max(
                    run.outputs.model_outputs, key=lambda output: output.step
                )
                if last_model:
                    trained_model = TrainedModel(run=run, model_id=last_model.model_id)
                    self.models.append(trained_model)


def get_current_model_id(s3, bucket, key) -> str:
    try:
        head_response = s3.head_object(Bucket=bucket, Key=key)
        metadata = head_response.get("Metadata", {})
        model_id = metadata.get("model_id") or ""
        return model_id
    except botocore.exceptions.ClientError as e:
        if e.response["Error"]["Code"] == "404":
            return ""
        raise


def get_current_thresholds(s3, bucket, key) -> dict:
    try:
        response = s3.get_object(Bucket=bucket, Key=key)
    except botocore.exceptions.ClientError as e:
        if e.response["Error"]["Code"] == "404":
            return {}
        raise
    file_content = response["Body"].read().decode("utf-8")

    json_data = json.loads(file_content)

    return json_data


def upload_artifacts(
    bucket: str,
    prefix: str,
    models: list[TrainedModel],
):
    s3 = boto3.client("s3")
    versions = s3.list_object_versions(Bucket=bucket, Prefix=prefix)
    uploaded = []

    thresholds_key = prefix + "thresholds.json"
    current_thresholds = get_current_thresholds(s3, bucket, thresholds_key)
    thresholds_changed = False
    try:
        for model in models:
            label_name = model.label_name
            object_name = prefix + label_name + ".bin"
            current_model_id = get_current_model_id(s3, bucket, object_name)
            if model.model_id != current_model_id:
                print(
                    f"uploading '{model.model_path} to bucket {bucket} at {object_name}"
                )
                s3.upload_file(
                    str(model.model_path),
                    bucket,
                    object_name,
                    ExtraArgs={"Metadata": {"model_id": model.model_id}},
                )
                print(f"uploaded {model.name}")
                uploaded.append(object_name)
                metrics = model.get_metrics()
                version = model.version.version if model.version else ""
                current_thresholds[label_name] = {
                    "threshold": float(metrics["threshold_at_recall"]),
                    "model_version": version,
                }
                thresholds_changed = True
            else:
                print(
                    f"model '{current_model_id}' already uploaded to bucket {bucket} at {object_name}"
                )

        if thresholds_changed:
            print(f"uploading thresholds to bucket {bucket} at {thresholds_key}")
            s3.put_object(
                Body=json.dumps(current_thresholds).encode(),
                ContentType="application/json",
                Bucket=bucket,
                Key=thresholds_key,
            )
            uploaded.append(thresholds_key)
    except Exception:
        rollback(s3, versions, bucket, uploaded)
        raise


def upload_run(experiment_id: str, args: dict):
    run_id = args["run_id"]
    bucket = args["bucket"]
    prefix = args["prefix"]

    models_to_upload = []
    artifacts = {}
    records = []

    training_results = TrainingResults(experiment_id, run_id)
    for model in training_results.models:
        label_name = model.label_name
        artifacts[label_name] = model.run_artifacts
        model_metrics = model.get_metrics(split=None)
        records.append({"label_name": label_name, **model_metrics})
        registered_model = model.find_registered_model()
        models_to_upload.append(registered_model)

    df = pd.DataFrame.from_records(records)

    if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
        upload_artifacts(bucket, prefix, models_to_upload)
    else:
        print("skipping uploading trained models, no credentials", flush=True)

    notify_success(
        experiment_id=experiment_id,
        run_id=run_id,
        run_artifacts=training_results.artifacts,
        df=df,
        artifacts=artifacts,
    )


def notify_success(
    experiment_id: str,
    run_id: str,
    df: pd.DataFrame,
    run_artifacts: Path,
    artifacts: dict[str, Path],
):
    df.sort_values(by="f1_score", inplace=True, ascending=False)
    table = df[
        [
            "label_name",
            "f1_score",
            "ap",
            "precision_at_recall",
            "ap_improvement",
            "pr_improvement",
        ]
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
    discord_webhook_url = os.environ.get("DISCORD_WEBHOOK_URL")
    if discord_webhook_url:
        print("sending Discord notification", flush=True)

    else:
        print("skipping sending Discord notification", flush=True)
        return

    webhook = DiscordWebhook(url=discord_webhook_url)
    webhook.set_content(content)

    for artifact in run_artifacts.glob("*test.png"):
        if artifact.is_file():
            with artifact.open("rb") as f:
                file_name = artifact.name
                webhook.add_file(f.read(), file_name)
                webhook.add_embed({"image": {"url": f"attachment://{file_name}"}})

    webhook.execute()


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
