import os
from importlib.metadata import version
from typing import Any

import fasttext
import mlflow
import numpy as np
import pandas as pd
from fasttext.FastText import _FastText
from mlflow import pyfunc
from mlflow.models import Model
from mlflow.models.model import MLMODEL_FILE_NAME
from mlflow.utils.environment import _CONDA_ENV_FILE_NAME, _PYTHON_ENV_FILE_NAME

import echo_ai

FLAVOR_NAME = "fasttext"


def save_model(mlflow_model, path: str, fasttext_model: _FastText):
    """Save fastText model in MLflow format"""

    # Validate and prepare save path
    os.makedirs(path, exist_ok=True)

    # Create MLflow model configuration
    model = Model()

    # Save the actual model
    model_data_subpath = "model.bin"
    model_data_path = os.path.join(path, model_data_subpath)

    fasttext_model.save_model(model_data_path)

    # Add PyFunc flavor for generic inference
    model = pyfunc.add_to_model(
        mlflow_model,
        __name__,  # Your module name
        model_path=model_data_subpath,
        conda_env=_CONDA_ENV_FILE_NAME,
        python_env=_PYTHON_ENV_FILE_NAME,
    )

    # Add custom flavor configuration
    model.add_flavor(
        FLAVOR_NAME,
        binary_model=model_data_subpath,
        fasttext_version=version("fasttext"),
        serialization_format="fasttext-binary",
    )

    # Save MLmodel configuration file
    model.save(os.path.join(path, MLMODEL_FILE_NAME))


def log_model(fasttext_model: _FastText, artifact_path: str, **kwargs):
    """Log fastText model to current MLflow run"""

    return Model.log(
        artifact_path,
        fasttext_model=fasttext_model,
        flavor=echo_ai.fasttext_model,  # Your module reference
        **kwargs,
    )


def load_model(model_uri: str) -> _FastText:
    """Load fastText model from MLflow format"""
    local_model_path = mlflow.artifacts.download_artifacts(model_uri)

    # Read flavor configuration
    model_config = Model.load(os.path.join(local_model_path, MLMODEL_FILE_NAME))
    flavor_conf = model_config.flavors[FLAVOR_NAME]

    # Load the pickled model
    model_path = os.path.join(local_model_path, flavor_conf["binary_model"])

    return fasttext.load_model(model_path)


class FastTextModelWrapper:
    """PyFunc wrapper for FastText models"""

    def __init__(self, fasttext_model: _FastText):
        self.fasttext_model = fasttext_model
        labels, freq = fasttext_model.f.getLabels("strict")
        index = [fasttext_model.get_label_id(label) for label in labels]
        self.label = pd.Series(labels, index=index, dtype=str)
        self.freq = pd.Series(freq, index=index, dtype=np.int64)

    def predict(self, model_input: pd.DataFrame, params: dict[str, Any] | None = None):
        """Predict using configuration DataFrame"""

        if model_input.shape[1] != 1:
            raise ValueError("DataFrame must have exactly 1 column")

        text = model_input.iloc[:, 0]
        nl = text.str.find("\n") != -1
        if nl.any():
            raise ValueError("DataFrame can't contain strings with '\\n'")

        text = text + "\n"

        text = text.to_list()
        if not params:
            params = {}

        k = params.get("k", -1)
        threshold = params.get("threshold", 0)

        on_unicode_error = "strict"

        all_labels, all_probs = self.fasttext_model.f.multilinePredict(
            text, k, threshold, on_unicode_error
        )

        def make_record(tuple):
            labels, probs = tuple
            row = {}
            for label, prob in zip(labels, probs):
                row[label] = prob
            return row

        records = map(make_record, zip(all_labels, all_probs))
        df = pd.DataFrame.from_records(records)
        df = df.reindex(columns=self.label, copy=False)

        return df


def _load_pyfunc(path):
    """Load model as PyFunc"""
    model = load_model(path)
    return FastTextModelWrapper(model)
