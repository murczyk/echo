import os
import sys
from importlib.metadata import version
from typing import Any

import fasttext
import numpy as np
import pandas as pd
from fasttext.FastText import _FastText, loss_name, model_name
from mlflow import pyfunc
from mlflow.artifacts import download_artifacts
from mlflow.models import Model
from mlflow.models.model import MLMODEL_FILE_NAME
from mlflow.utils.environment import _CONDA_ENV_FILE_NAME, _PYTHON_ENV_FILE_NAME

FLAVOR_NAME = "fasttext"
UNSUPERVISED_ARGS = [
    "model",
    "lr",
    "dim",
    "ws",
    "epoch",
    "minCount",
    "minCountLabel",
    "minn",
    "maxn",
    "neg",
    "wordNgrams",
    "loss",
    "bucket",
    "thread",
    "lrUpdateRate",
    "t",
    "label",
    "verbose",
    "pretrainedVectors",
]
SUPERVISED_ARGS = [
    "lr",
    "dim",
    "ws",
    "epoch",
    "minCount",
    "minCountLabel",
    "minn",
    "maxn",
    "neg",
    "wordNgrams",
    "loss",
    "bucket",
    "thread",
    "lrUpdateRate",
    "t",
    "label",
    "verbose",
    "pretrainedVectors",
    "seed",
    "autotuneValidationFile",
    "autotuneMetric",
    "autotunePredictions",
    "autotuneDuration",
    "autotuneModelSize",
]


def save_model(
    mlflow_model,
    path: str,
    fasttext_model: _FastText,
    pretrained_vectors: str | None = None,
):
    """Save fastText model in MLflow format"""

    # Validate and prepare save path
    os.makedirs(path, exist_ok=True)

    # Create MLflow model configuration
    model = Model()

    # Save the actual model
    model_data_subpath = "model.bin"
    model_data_path = os.path.join(path, model_data_subpath)

    fasttext_model.save_model(model_data_path)

    # Save word vectors
    if pretrained_vectors:
        pretrained_vectors = os.path.basename(pretrained_vectors)
        pretrained_vectors_path = os.path.join(path, pretrained_vectors)
        write_word_vectors(fasttext_model, pretrained_vectors_path)
    else:
        pretrained_vectors = None

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
        pretrained_vectors=pretrained_vectors,
        serialization_format="fasttext-binary",
    )

    # Save MLmodel configuration file
    model.save(os.path.join(path, MLMODEL_FILE_NAME))


def log_model(fasttext_model: _FastText, name: str, **kwargs):
    """Log fastText model to current MLflow run"""

    return Model.log(
        name,
        fasttext_model=fasttext_model,
        flavor=sys.modules[__name__],  # Your module reference
        **kwargs,
    )


def load_model(model_uri: str) -> _FastText:
    """Load fastText model from MLflow format"""
    local_model_path = download_artifacts(model_uri)

    # Read flavor configuration
    model_config = Model.load(os.path.join(local_model_path, MLMODEL_FILE_NAME))
    flavor_conf = model_config.flavors[FLAVOR_NAME]

    # Load the binary model
    model_path = os.path.join(local_model_path, flavor_conf["binary_model"])

    return fasttext.load_model(model_path)


class FastTextModelWrapper:
    """PyFunc wrapper for FastText models"""

    def __init__(self, fasttext_model: _FastText):
        self.fasttext_model = fasttext_model
        label, freq = fasttext_model.f.getLabels("strict")
        index = pd.Series(
            [fasttext_model.get_label_id(label) for label in label], dtype=np.int32
        )
        label = pd.Series(label, index=index, dtype=str)
        freq = pd.Series(freq, index=index, dtype=np.int64)
        d = {"label": label, "freq": freq}
        self.label_freq = pd.DataFrame(d, index=index)

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
        df = pd.DataFrame.from_records(records, columns=self.label_freq["label"])

        positive_label = params.get("positive_label")
        if positive_label:
            df = df[positive_label]
        if "threshold" in params:
            df = (df > threshold).astype(int)

        return df


def _load_pyfunc(path):
    """Load model as PyFunc"""
    model = load_model(path)
    return FastTextModelWrapper(model)


def get_training_args(keys: list[str], **kwargs):
    return {
        key: value for key, value in kwargs.items() if key in keys and value is not None
    }


def get_model_params(model: _FastText):
    args = model.f.getArgs()
    params = {}
    keys = SUPERVISED_ARGS if args.model == model_name.supervised else UNSUPERVISED_ARGS

    for key in keys:
        params[key] = getattr(args, key)

    if "model" in params:
        params["model"] = convert_model_name(params["model"])

    if "loss" in params:
        params["loss"] = convert_loss_name(params["loss"])

    return params


def convert_model_name(model):
    if model == model_name.cbow:
        return "cbow"
    if model == model_name.skipgram:
        return "skipgram"
    if model == model_name.supervised:
        return "supervised"
    else:
        raise ValueError("Unrecognized model name")


def convert_loss_name(loss):
    if loss == loss_name.ns:
        return "ns"
    if loss == loss_name.hs:
        return "hs"
    if loss == loss_name.softmax:
        return "softmax"
    if loss == loss_name.ova:
        return "ova"
    else:
        raise ValueError("Unrecognized loss name")


def write_word_vectors(model: _FastText, path: str):
    words = model.words
    num_words = len(words)
    dim = model.get_dimension()

    with open(path, "w") as f:
        f.write(f"{num_words} {dim}\n")
        for w in words:
            f.write(w)
            f.write(" ")

            v = model.get_word_vector(w)
            vstr = " ".join(map(str, v))
            f.write(vstr)
            f.write("\n")
