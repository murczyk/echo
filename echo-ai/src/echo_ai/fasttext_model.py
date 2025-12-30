import os
import sys
from importlib.metadata import version
from typing import Any, cast

import fasttext
import numpy as np
import pandas as pd
from fasttext.FastText import _FastText, loss_name, model_name
from mlflow import pyfunc
from mlflow.artifacts import download_artifacts
from mlflow.models import Model
from mlflow.models.evaluation.evaluators import classifier
from mlflow.models.model import MLMODEL_FILE_NAME
from mlflow.pyfunc import PyFuncModel
from mlflow.pyfunc.model import PythonModel, PythonModelContext
from mlflow.utils.environment import _CONDA_ENV_FILE_NAME, _PYTHON_ENV_FILE_NAME

original_extract_predict_fns = classifier._extract_predict_fn_and_prodict_proba_fn  # pyright: ignore


def _patched_extract_predict_fns(model: PyFuncModel | None):
    predict_fn, predict_proba_fn = original_extract_predict_fns(model)

    if model and predict_proba_fn is None:
        model_predict_fn = model._predict_fn
        signature = model_predict_fn.__func__

        if signature is FastTextPythonModel.predict:

            def func(input_data):
                params = {"method": "predict_proba"}
                return model_predict_fn(input_data, params)

            predict_proba_fn = func

    return predict_fn, predict_proba_fn


classifier._extract_predict_fn_and_prodict_proba_fn = _patched_extract_predict_fns  # pyright: ignore

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


class _FastTextModelWrapper:
    """PyFunc wrapper for FastText models"""

    def __init__(self, fasttext_model: _FastText):
        self.fasttext_model = fasttext_model
        label, freq = fasttext_model.f.getLabels("strict")
        label_dict = {fasttext_model.get_label_id(label): label for label in label}
        freq = pd.Series(freq, index=label_dict.keys(), dtype=np.int64)
        freq.sort_index(inplace=True)
        freq.rename(index=label_dict, inplace=True)
        self.label_freq = freq

    def predict(
        self,
        context: PythonModelContext,
        model_input: pd.DataFrame,
        params: dict[str, Any] | None = None,
    ) -> pd.DataFrame | pd.Series | np.ndarray:
        if model_input.shape[1] != 1:
            raise ValueError("DataFrame must have exactly 1 column")

        text = model_input.iloc[:, 0]
        nl = text.str.find("\n") != -1
        if nl.any():
            raise ValueError("DataFrame can't contain strings with '\\n'")

        text = text + "\n"

        text = text.to_list()

        k = -1
        threshold = 0
        on_unicode_error = "strict"
        all_labels, all_probs = self.fasttext_model.f.multilinePredict(
            text, k, threshold, on_unicode_error
        )

        def make_record(tuple):
            labels, probs = tuple
            row = {}
            for label, prob in zip(labels, probs):
                if prob > 1.0:
                    prob = 1.0
                row[label] = prob
            return row

        records = map(make_record, zip(all_labels, all_probs))
        df = pd.DataFrame.from_records(records, columns=self.label_freq.index)

        if not params:
            params = {}
        model_config = {}
        if context and context.model_config:
            model_config = cast(dict[str, Any], context.model_config)

        settings = params | model_config
        method = settings.get("method", model_config.get("method"))

        if method == "predict_proba":
            return df.to_numpy()
        else:
            positive_label = settings.get(
                "positive_label", model_config.get("positive_label")
            )
            if positive_label:
                df = df[positive_label]
            threshold = params.get("threshold", model_config.get("threshold", 0.5))
            if threshold is not None:
                df = df > threshold

        return df


class FastTextPythonModel(PythonModel):
    def __init__(self, fasttext_model: _FastText) -> None:
        self.wrapper = _FastTextModelWrapper(fasttext_model)

    def load_context(self, context: PythonModelContext):
        self.context = context

    def get_raw_model(self) -> _FastText:
        return self.wrapper.fasttext_model

    def predict(
        self, model_input, params: dict[str, Any] | None = None
    ) -> pd.DataFrame | pd.Series | np.ndarray:
        return self.wrapper.predict(self.context, model_input, params)


def get_python_model(fasttext_model: _FastText, model_config: dict[str, Any] = {}):
    model = FastTextPythonModel(fasttext_model)
    context = PythonModelContext(artifacts={}, model_config=model_config)
    model.load_context(context)
    return model


def get_pyfunc_model(
    fasttext_model: _FastText,
    model_config: dict[str, Any] = {},
    model_id: str | None = None,
):
    python_model = get_python_model(fasttext_model, model_config)
    model = Model()
    model = pyfunc.add_to_model(
        model,
        __name__,  # Your module name
        conda_env=_CONDA_ENV_FILE_NAME,
        python_env=_PYTHON_ENV_FILE_NAME,
    )
    return pyfunc.PyFuncModel(model, python_model, model_id=model_id)


def _load_pyfunc(path, model_config: dict[str, Any] = {}):
    """Load model as PyFunc"""
    model = load_model(path)
    return get_python_model(fasttext_model=model, model_config=model_config)


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
