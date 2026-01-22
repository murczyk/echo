from typing import Any, cast

import mlflow
import pandas as pd
from mlflow import models, sklearn
from mlflow.data.huggingface_dataset import HuggingFaceDataset
from mlflow.data.pandas_dataset import from_pandas
from sklearn.linear_model import LogisticRegression

from echo_ai import utils


def train_embeddings(
    label_dict: dict[int, str],
    dataset: HuggingFaceDataset,
    args: dict[str, Any],
):
    ds = dataset.ds

    ds = ds.train_test_split(train_size=0.8)
    ds_train = utils.to_pandas_df(ds["train"])
    ds_test = utils.to_pandas_df(ds["test"])

    ds_train = ds_train.dropna()
    ds_test = ds_test.dropna()

    x_train = cast(pd.Series, ds_train["embeddings"])
    x_train = utils.to_numpy_matrix(x_train)
    x_test = cast(pd.Series, ds_test["embeddings"])
    x_test = utils.to_numpy_matrix(x_test)

    mlflow.set_experiment("ECHO Embedding")
    with mlflow.start_run():
        for label_index, label_name in label_dict.items():
            key = f"label_{label_index}"
            print(f"training {key} {label_name}")

            label_train = cast(pd.DataFrame, ds_train[["embeddings", key]])
            print(label_train.head())

            m = LogisticRegression(class_weight="balanced")
            run_tags = {
                "label": label_name,
                "model": "embeddings",
                "estimator": type(m).__name__,
            }
            with mlflow.start_run(nested=True, tags=run_tags):
                y_train = ds_train[key].to_numpy()
                m.fit(x_train, y_train)
                mlflow.log_params(m.get_params(deep=True))
                model_info = sklearn.log_model(m, name=f"supervised-{label_name}")
                y_test = ds_test[key].to_numpy()

                result = models.evaluate(
                    model_info.model_uri,
                    x_test,
                    targets=y_test,
                    model_type="classifier",
                )
