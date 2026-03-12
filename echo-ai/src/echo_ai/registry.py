from pathlib import Path
from typing import Any, cast

import mlflow
import mlflow.artifacts
from mlflow.entities import LoggedModel, Run
from mlflow.entities.model_registry import ModelVersion


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
    def model_id(self) -> str:
        return self.model.model_id

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

    def get_metrics(self, split: str | None = "test") -> dict[str, Any]:
        metrics_list = self.model.metrics or []
        metrics_dict = {
            metric.key: metric.value
            for metric in metrics_list
            if not split or (metric.dataset_name and split in metric.dataset_name)
        }
        return metrics_dict
