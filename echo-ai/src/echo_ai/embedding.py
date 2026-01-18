from typing import Any, cast

import mlflow
import numpy as np
import pandas as pd
from mlflow import models, sklearn
from mlflow.data.huggingface_dataset import HuggingFaceDataset
from pandas import DataFrame
from sklearn.linear_model import LogisticRegression


def train_embedding(
    label_dict: dict[int, str],
    dataset: HuggingFaceDataset,
    df: DataFrame,
    args: dict[str, Any],
):
    ds = dataset.ds

    ds = ds.sort("__datetime")
    ds = ds.train_test_split(train_size=0.8)
    ds_train = ds["train"].to_pandas()
    ds_test = ds["test"].to_pandas()

    ds_train = cast(DataFrame, ds_train)
    ds_test = cast(DataFrame, ds_test)

    ds_train = ds_train.dropna()
    ds_test = ds_test.dropna()

    x_train = ds_train["embedding"].to_numpy()
    x_train = np.stack(x_train)

    x_test = ds_test["embedding"].to_numpy()
    x_test = np.stack(x_test)

    for label_index, label_name in label_dict.items():
        mlflow.set_experiment(f"ECHO Embedding {label_name}")
        with mlflow.start_run() as run:
            key = f"label_{label_index}"
            print(f"training {key} {label_name}")
            y_train = ds_train[key].to_numpy()
            m = LogisticRegression(class_weight="balanced")
            m.fit(x_train, y_train)

            model_info = sklearn.log_model(m)
            y_test = ds_test[key].to_numpy()

            result = models.evaluate(
                model_info.model_uri,
                x_test,
                targets=y_test,
                model_type="classifier",
            )
