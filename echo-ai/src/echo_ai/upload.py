import json
import os
import urllib.parse
from pathlib import Path
from typing import Any, cast

import boto3
import mlflow
import mlflow.artifacts
import pandas as pd
from discord_webhook import DiscordWebhook
from mlflow.entities import LoggedModel, Run
from mlflow.entities.model_registry import ModelVersion


def get_filter_string(run_id: str):
    return f"tags.mlflow.parentRunId = '{run_id}'"


class TrainedModel:
    run: Run
    model: LoggedModel
    run_artifacts: Path
    model_artifacts: Path
    version: ModelVersion | None

    def __init__(self, run: Run, version: ModelVersion | None = None):
        self.run = run
        run_artifacts = mlflow.artifacts.download_artifacts(run_id=run.info.run_id)
        self.run_artifacts = Path(run_artifacts)
        [model_output] = run.outputs.model_outputs
        self.model = mlflow.get_logged_model(model_id=model_output.model_id)
        model_artifacts = mlflow.artifacts.download_artifacts(
            artifact_uri=f"models:/{model_output.model_id}"
        )
        self.model_artifacts = Path(model_artifacts)
        self.version = version

    @property
    def name(self) -> str:
        return self.model.name

    @property
    def params(self) -> dict[str, str]:
        return self.model.params

    @property
    def label_name(self) -> str:
        return self.model.params["label_name"]

    def find_registered_model(self) -> "TrainedModel | None":
        filter_string = f"name = '{self.model.name}'"
        for result in mlflow.search_registered_models(filter_string=filter_string):
            latest_versions = result.latest_versions
            if latest_versions:
                [latest_version] = latest_versions
                run_id = str(latest_version.run_id)
                run = mlflow.get_run(run_id)
                version = cast(ModelVersion, latest_version)
                return TrainedModel(run, version)
        return None

    def register(self) -> ModelVersion:
        run_id = self.run.info.run_id
        print(f"registering model '{self.model.name}' from run '{run_id}'", flush=True)
        model_version = mlflow.register_model(
            f"runs:/{run_id}/{self.model.name}", self.model.name
        )
        print(
            f"successfully registered model '{self.model.name}' version {model_version.version} from run '{run_id}'",
            flush=True,
        )
        return model_version

    @property
    def model_path(self) -> Path:
        return self.model_artifacts / "model.bin"

    def get_metrics(self, split: str = "test") -> dict[str, Any]:
        metrics_list = self.model.metrics or []
        metrics_dict = {
            metric.key: metric.value
            for metric in metrics_list
            if metric.dataset_name and split in metric.dataset_name
        }
        return metrics_dict


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
        self.models = [TrainedModel(run=run) for run in runs]


def rollback(
    s3, versions, bucket: str, keys: list[str], registered: list[ModelVersion]
):
    client = mlflow.MlflowClient()
    for version in registered:
        client.delete_model_version(version.name, version.version)

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
    bucket: str,
    prefix: str,
    thresholds: dict[str, dict],
    models: list[TrainedModel],
):
    s3 = boto3.client("s3")
    versions = s3.list_object_versions(Bucket=bucket, Prefix=prefix)
    uploaded = []
    registered = []
    try:
        for model in models:
            label_name = model.label_name
            object_name = prefix + label_name + ".bin"
            model_path = model.model_path
            print(f"uploading '{model_path} to bucket {bucket} at {object_name}")
            s3.upload_file(str(model_path), bucket, object_name)
            print(f"uploaded {model.name}")
            uploaded.append(object_name)

            model_version = model.register()
            registered.append(model_version)
            print(f"new version {model_version.version} for {model.name} registered")
            thresholds[label_name]["version"] = model_version.version

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
        rollback(s3, versions, bucket, uploaded, registered)
        raise


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


def get_report_record(params: dict, metrics: dict):
    return {
        "label_name": params["label_name"],
        "ap_improvement": None,
        "pr_improvement": None,
        **metrics,
    }


def should_upload_model(
    args: dict,
    challenger: TrainedModel,
    metrics: dict,
    registered: TrainedModel,
    registered_metrics: dict,
) -> tuple[bool, dict]:
    new_ap = float(metrics["ap"])
    new_precision_at_recall = float(metrics["precision_at_recall"])

    old_ap = float(registered_metrics["ap"])
    old_precision_at_recall = float(registered_metrics["precision_at_recall"])

    ap_improvement = (new_ap - old_ap) / old_ap
    pr_improvement = (
        new_precision_at_recall - old_precision_at_recall
    ) / old_precision_at_recall

    ap_limit = args["ap_limit"]
    pr_limit = args["pr_limit"]

    version = registered.version.version if registered.version else ""
    print(
        f"comparing '{challenger.name}' to '{registered.name}' version {version}",
        flush=True,
    )
    stats = {
        "ap_improvement": ap_improvement,
        "pr_improvement": pr_improvement,
    }
    if ap_improvement > 0 and pr_improvement > 0:
        print(
            f"best new version, improved ap {ap_improvement:+.2%}, improved precision_at_recall {pr_improvement:+.2%}",
            flush=True,
        )
        return True, stats

    if ap_improvement > abs(pr_limit) and pr_improvement > pr_limit:
        print(
            f"good new version improved ap {ap_improvement:+.2%}, worse precision_at_recall {pr_improvement:+.2%}",
            flush=True,
        )
        return True, stats

    if pr_improvement > abs(ap_limit) and ap_improvement > ap_limit:
        print(
            f"good new version worse ap {ap_improvement:+.2%}, improved precision_at_recall {pr_improvement:+.2%}",
            flush=True,
        )
        return True, stats

    if ap_improvement != 0 and pr_improvement != 0:
        print(
            f"bad version worse ap {ap_improvement:+.2%}, worse precision_at_recall {pr_improvement:+.2%}",
            flush=True,
        )
    return False, stats


def upload_run(experiment_id: str, args: dict):
    run_id = args["run_id"]
    bucket = args["bucket"]
    prefix = args["prefix"]

    models_to_upload = []
    artifacts = {}
    thresholds = {}
    records = []

    training_results = TrainingResults(experiment_id, run_id)
    for model in training_results.models:
        label_name = model.label_name
        artifacts[label_name] = model.run_artifacts
        model_metrics = model.get_metrics()
        record = get_report_record(model.params, model_metrics)

        threshold = model_metrics["threshold_at_recall"]

        registered_model = model.find_registered_model()
        if registered_model and registered_model.version:
            registered_metrics = registered_model.get_metrics()
            should_upload, stats = should_upload_model(
                args, model, model_metrics, registered_model, registered_metrics
            )
            record = {**record, **stats}
            if should_upload:
                print(f"will attempt to upload {model.name}")
                models_to_upload.append(model)
                thresholds[label_name] = {"threshold": threshold}
            else:
                print(f"skipping uploading of {model.name}, no improvement")
                thresholds[label_name] = {
                    "threshold": registered_metrics["threshold_at_recall"],
                    "model_version": registered_model.version.version,
                }
        else:
            print(f"no previous version of {model.name}, will attempt to upload")
            models_to_upload.append(model)

        records.append(record)

    df = pd.DataFrame.from_records(records)

    if os.environ.get("AWS_ACCESS_KEY_ID") and os.environ.get("AWS_SECRET_ACCESS_KEY"):
        if models_to_upload:
            print(
                f"will register and upload {len(models_to_upload)} trained models",
                flush=True,
            )
            upload_artifacts(bucket, prefix, thresholds, models_to_upload)
        else:
            print("no models to upload", flush=True)
    else:
        print("skipping uploading trained models, no credentials", flush=True)

    notify_success(
        experiment_id=experiment_id,
        run_id=run_id,
        run_artifacts=training_results.artifacts,
        df=df,
        artifacts=artifacts,
    )
